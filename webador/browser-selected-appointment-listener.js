"use strict";

// Merge this with the existing Webador postMessage listener. It preserves the
// Calenso eventName -> dataLayer event passthrough and only notifies n8n for
// the browser-selected appointment UUID observed on APPOINTMENT_BOOKING_DONE.
(function () {
  var NOTIFY_ENDPOINT = "https://YOUR_PUBLIC_N8N_HOST/webhook/calenso-browser-selected-appointment";
  var EXPECTED_CALENSO_ORIGIN = "https://widget.calenso.com";
  var MAX_NOTIFY_ATTEMPTS = 3;
  var RETRY_DELAYS_MS = [1000, 5000];
  var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  var selectedAppointmentUuid = null;
  var notifiedUuids = {};
  var notifyInFlight = {};
  var notifyAttempts = {};
  var pushedStepSuccessUuids = {};

  function findCalensoIframeWindow() {
    var frames = document.querySelectorAll("iframe");
    for (var index = 0; index < frames.length; index += 1) {
      var frame = frames[index];
      var src = frame.getAttribute("src") || "";
      if (src.indexOf(EXPECTED_CALENSO_ORIGIN) === 0) {
        return frame.contentWindow;
      }
    }
    return null;
  }

  function isExpectedMessageSource(messageEvent) {
    if (!messageEvent || messageEvent.origin !== EXPECTED_CALENSO_ORIGIN) {
      return false;
    }

    var iframeWindow = findCalensoIframeWindow();
    return Boolean(iframeWindow && messageEvent.source === iframeWindow);
  }

  function getSelectedAppointmentUuid(data) {
    var bookingData = data && data.bookingData;
    var rawUuid = null;

    if (Array.isArray(bookingData) && bookingData[0]) {
      rawUuid = bookingData[0].uuid;
    } else if (bookingData && typeof bookingData === "object") {
      rawUuid = bookingData.uuid;
    }

    if (typeof rawUuid !== "string") {
      return null;
    }

    var appointmentUuid = rawUuid.trim().toLowerCase();
    return UUID_PATTERN.test(appointmentUuid) ? appointmentUuid : null;
  }

  function pushDataLayerEvent(eventName, appointmentUuid, rawData) {
    window.dataLayer = window.dataLayer || [];

    if (eventName === "appointment_booking_step_success" && appointmentUuid) {
      if (pushedStepSuccessUuids[appointmentUuid]) {
        return;
      }
      pushedStepSuccessUuids[appointmentUuid] = true;
    }

    var item = {
      event: eventName,
    };

    if (appointmentUuid) {
      item.appointment_uuid = appointmentUuid;
    }

    if (rawData && rawData.stepName) {
      item.stepName = rawData.stepName;
    }

    window.dataLayer.push(item);
  }

  function buildPayload(appointmentUuid) {
    return JSON.stringify({
      appointment_uuid: appointmentUuid,
    });
  }

  function isStateStoreAccepted(response) {
    if (!response || !response.ok || typeof response.json !== "function") {
      return Promise.resolve(false);
    }

    return response.json().then(function (decision) {
      return Boolean(decision && ["WAIT", "SEND_ENHANCEMENT", "SKIP"].indexOf(decision.action) !== -1);
    }).catch(function () {
      return false;
    });
  }

  function notifyServer(appointmentUuid) {
    if (!appointmentUuid || notifiedUuids[appointmentUuid] || notifyInFlight[appointmentUuid]) {
      return;
    }

    var attempt = notifyAttempts[appointmentUuid] || 0;
    if (attempt >= MAX_NOTIFY_ATTEMPTS) {
      return;
    }

    notifyAttempts[appointmentUuid] = attempt + 1;
    notifyInFlight[appointmentUuid] = true;

    function scheduleRetry() {
      notifyInFlight[appointmentUuid] = false;
      var nextDelay = RETRY_DELAYS_MS[attempt];
      if (typeof nextDelay === "number") {
        window.setTimeout(function () {
          notifyServer(appointmentUuid);
        }, nextDelay);
      }
    }

    if (typeof fetch === "function") {
      fetch(NOTIFY_ENDPOINT, {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
        },
        body: buildPayload(appointmentUuid),
      }).then(function (response) {
        notifyInFlight[appointmentUuid] = false;
        return isStateStoreAccepted(response).then(function (accepted) {
          if (accepted) {
            notifiedUuids[appointmentUuid] = true;
            return;
          }
          scheduleRetry();
        });
      }).catch(scheduleRetry);
      return;
    }

    notifyInFlight[appointmentUuid] = false;
    if (navigator.sendBeacon) {
      navigator.sendBeacon(NOTIFY_ENDPOINT, new Blob([buildPayload(appointmentUuid)], { type: "application/json" }));
    }
    scheduleRetry();
  }

  function handleCalensoMessage(messageEvent) {
    if (!isExpectedMessageSource(messageEvent)) {
      return;
    }

    var data = messageEvent && messageEvent.data;
    var eventName = data && data.eventName;
    if (typeof eventName !== "string" || eventName === "") {
      return;
    }

    var appointmentUuid = getSelectedAppointmentUuid(data) || selectedAppointmentUuid;

    if (eventName === "APPOINTMENT_BOOKING_DONE") {
      appointmentUuid = getSelectedAppointmentUuid(data);
      if (appointmentUuid) {
        selectedAppointmentUuid = appointmentUuid;
        notifyServer(appointmentUuid);
      }
      pushDataLayerEvent(eventName, appointmentUuid, data);
      return;
    }

    pushDataLayerEvent(eventName, appointmentUuid, data);
  }

  window.addEventListener("message", handleCalensoMessage);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      getSelectedAppointmentUuid: getSelectedAppointmentUuid,
      handleCalensoMessage: handleCalensoMessage,
    };
  }
})();
