const socket = io();

const toast = document.getElementById("toast");
const registrationForm = document.getElementById("registrationForm");
const trackingForm = document.getElementById("trackingForm");
const trackingCodeInput = document.getElementById("trackingCode");

const trackingStatus = document.getElementById("trackingStatus");
const deliveryInfo = document.getElementById("deliveryInfo");
const locationText = document.getElementById("locationText");
const createdCode = document.getElementById("createdCode");
const mapLink = document.getElementById("mapLink");

const startGpsButton = document.getElementById("startGpsButton");
const stopGpsButton = document.getElementById("stopGpsButton");
const confirmDeliveredButton = document.getElementById("confirmDeliveredButton");

let toastTimer;
let currentCode = "";
let currentDelivery = null;
let gpsWatchId = null;
let organisationGps = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4000);
}

function setTrackingCode(code) {
  currentCode = code.trim().toUpperCase();
  trackingCodeInput.value = currentCode;

  if (!currentCode) return;

  socket.emit("join-delivery", currentCode);
  startGpsButton.disabled = false;
}

function renderDelivery(delivery) {
  currentDelivery = delivery;

  const labels = {
    requested: "Request received",
    in_transit: "Delivery in progress",
    near_destination: "Near destination — confirm handoff",
    delivered: "Delivered"
  };

  trackingStatus.textContent = labels[delivery.status] || delivery.status;
  deliveryInfo.textContent =
    `${delivery.food} for ${delivery.organization.name}, ${delivery.organization.city}. ` +
    `Code: ${delivery.code}`;

  if (delivery.location) {
    const { latitude, longitude, accuracy } = delivery.location;
    locationText.textContent =
      `Latest delivery GPS: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}` +
      (accuracy ? ` (accuracy about ${Math.round(accuracy)} m)` : "");

    mapLink.href = `https://www.google.com/maps?q=${latitude},${longitude}`;
    mapLink.hidden = false;
  } else {
    locationText.textContent = "No GPS location received yet.";
    mapLink.hidden = true;
  }

  startGpsButton.disabled = !currentCode || gpsWatchId !== null || delivery.status === "delivered";
  stopGpsButton.disabled = gpsWatchId === null;
  confirmDeliveredButton.disabled = delivery.status !== "near_destination";
}

socket.on("delivery-update", (delivery) => {
  if (delivery.code !== currentCode) return;

  renderDelivery(delivery);

  if (delivery.status === "near_destination") {
    showToast("GPS shows the delivery near its destination. Confirm the handoff.");
  } else if (delivery.status === "delivered") {
    showToast("Delivery marked as delivered.");
    stopGpsSharing();
  }
});

socket.on("tracking-error", (message) => {
  showToast(message);
});

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "The request could not be completed.");
  }

  return result;
}

// Capture the organisation's location before registration.
document.getElementById("setOrgLocationButton").addEventListener("click", () => {
  const message = document.getElementById("orgLocationMessage");

  if (!navigator.geolocation) {
    message.textContent = "GPS is not available in this browser.";
    return;
  }

  message.textContent = "Waiting for location permission…";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      organisationGps = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      };

      message.textContent =
        `Location captured: ${organisationGps.latitude.toFixed(5)}, ` +
        `${organisationGps.longitude.toFixed(5)}`;
      showToast("Organisation GPS location captured.");
    },
    () => {
      message.textContent = "Location was not available. Allow access and try again.";
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

// Register the organisation with the server.
registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const form = new FormData(registrationForm);

  try {
    const result = await postJson("/api/organizations", {
      name: document.getElementById("orgName").value.trim(),
      type: document.getElementById("orgType").value,
      contact: document.getElementById("contactName").value.trim(),
      email: document.getElementById("orgEmail").value.trim(),
      phone: document.getElementById("orgPhone").value.trim(),
      city: document.getElementById("orgCity").value.trim(),
      people: Number(document.getElementById("peopleCount").value),
      latitude: organisationGps?.latitude ?? null,
      longitude: organisationGps?.longitude ?? null
    });

    localStorage.setItem("foodBridgeOrganizationId", result.organization.id);
    localStorage.setItem("foodBridgeOrganizationName", result.organization.name);

    registrationForm.reset();
    organisationGps = null;
    document.getElementById("orgLocationMessage").textContent = "No GPS location captured yet.";
    showToast("Organisation registered with the server.");
  } catch (error) {
    showToast(error.message);
  }
});

// Create a delivery request for the registered organisation.
document.querySelectorAll(".request-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const organizationId = localStorage.getItem("foodBridgeOrganizationId");

    if (!organizationId) {
      showToast("Register your organisation before requesting food.");
      document.getElementById("register").scrollIntoView({ behavior: "smooth" });
      return;
    }

    try {
      const result = await postJson("/api/deliveries", {
        food: button.dataset.food,
        organizationId
      });

      createdCode.textContent = `Share this tracking code: ${result.delivery.code}`;
      setTrackingCode(result.delivery.code);
      document.getElementById("tracking").scrollIntoView({ behavior: "smooth" });
      showToast("Request created. Share the code with the delivery person.");
    } catch (error) {
      showToast(error.message);
    }
  });
});

// Track an existing delivery using its code.
trackingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createdCode.textContent = "";
  setTrackingCode(trackingCodeInput.value);
});

// Share the delivery device's live GPS with everyone tracking this code.
startGpsButton.addEventListener("click", () => {
  if (!currentCode) {
    showToast("Enter a delivery tracking code first.");
    return;
  }

  if (!navigator.geolocation) {
    showToast("GPS is not available in this browser.");
    return;
  }

  gpsWatchId = navigator.geolocation.watchPosition(
    (position) => {
      socket.emit("driver-location", {
        code: currentCode,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      });

      startGpsButton.disabled = true;
      stopGpsButton.disabled = false;
    },
    (error) => {
      showToast(error.code === error.PERMISSION_DENIED
        ? "Location permission was denied."
        : "Could not get GPS. Check your device settings.");

      stopGpsSharing();
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
  );

  startGpsButton.disabled = true;
  stopGpsButton.disabled = false;
});

function stopGpsSharing() {
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }

  stopGpsButton.disabled = true;
  startGpsButton.disabled = !currentCode || currentDelivery?.status === "delivered";
}

stopGpsButton.addEventListener("click", stopGpsSharing);

// Confirm handoff after GPS reports the delivery near its destination.
confirmDeliveredButton.addEventListener("click", () => {
  if (currentCode) {
    socket.emit("confirm-delivered", currentCode);
  }
});

// Mobile navigation
const menuButton = document.getElementById("menuButton");
const navLinks = document.getElementById("navLinks");

menuButton.addEventListener("click", () => {
  const isOpen = navLinks.classList.toggle("open");
  menuButton.setAttribute("aria-expanded", String(isOpen));
  menuButton.textContent = isOpen ? "×" : "☰";
});

navLinks.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    navLinks.classList.remove("open");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.textContent = "☰";
  });
});