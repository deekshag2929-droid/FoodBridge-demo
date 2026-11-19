const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ organizations: [], deliveries: [] }, null, 2));
  }

  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { organizations: [], deliveries: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function makeId(length = 8) {
  return crypto.randomBytes(length).toString("hex").slice(0, length).toUpperCase();
}

function distanceMetres(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const earthRadius = 6371000;
  const latDifference = radians(lat2 - lat1);
  const lonDifference = radians(lon2 - lon1);

  const value =
    Math.sin(latDifference / 2) ** 2 +
    Math.cos(radians(lat1)) *
      Math.cos(radians(lat2)) *
      Math.sin(lonDifference / 2) ** 2;

  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

app.get("/api/health", (req, res) => {
  res.json({ status: "FoodBridge server is running" });
});

app.post("/api/organizations", (req, res) => {
  const { name, type, contact, email, phone, city, people, latitude, longitude } = req.body;

  if (!name || !type || !contact || !email || !phone || !city) {
    return res.status(400).json({ error: "Please complete all required organisation fields." });
  }

  const organization = {
    id: makeId(12),
    name: String(name).trim(),
    type: String(type).trim(),
    contact: String(contact).trim(),
    email: String(email).trim(),
    phone: String(phone).trim(),
    city: String(city).trim(),
    people: Number(people) || 0,
    latitude: Number.isFinite(Number(latitude)) ? Number(latitude) : null,
    longitude: Number.isFinite(Number(longitude)) ? Number(longitude) : null,
    createdAt: new Date().toISOString()
  };

  const data = readData();
  data.organizations.push(organization);
  writeData(data);

  res.status(201).json({ organization });
});

app.post("/api/animal-food-offers", (req, res) => {
  const { donorName, donorContact, foodType, amount, bestBefore, pickupArea, notes } = req.body;

  if (!donorName || !donorContact || !foodType || !amount || !pickupArea) {
    return res.status(400).json({ error: "Please complete your name, contact, food, amount, and pickup area." });
  }

  const offer = {
    reference: makeId(8),
    donorName: String(donorName).trim().slice(0, 100),
    donorContact: String(donorContact).trim().slice(0, 120),
    foodType: String(foodType).trim().slice(0, 80),
    amount: String(amount).trim().slice(0, 120),
    bestBefore: bestBefore ? String(bestBefore).slice(0, 10) : null,
    pickupArea: String(pickupArea).trim().slice(0, 160),
    notes: String(notes || "").trim().slice(0, 500),
    status: "offered",
    createdAt: new Date().toISOString()
  };

  const data = readData();
  data.animalFoodOffers = data.animalFoodOffers || [];
  data.animalFoodOffers.push(offer);
  writeData(data);

  res.status(201).json({ offer: { reference: offer.reference, status: offer.status } });
});

app.get("/api/organizations", (req, res) => {
  const data = readData();
  res.json(data.organizations.map(({ id, name, type, city }) => ({ id, name, type, city })));
});

app.post("/api/deliveries", (req, res) => {
  const { food, organizationId } = req.body;

  if (!food || !organizationId) {
    return res.status(400).json({ error: "Choose food and register an organisation first." });
  }

  const data = readData();
  const organization = data.organizations.find((item) => item.id === organizationId);

  if (!organization) {
    return res.status(404).json({ error: "Organisation not found. Please register it again." });
  }

  const delivery = {
    code: makeId(8),
    food: String(food),
    organization: {
      id: organization.id,
      name: organization.name,
      city: organization.city,
      latitude: organization.latitude,
      longitude: organization.longitude
    },
    status: "requested",
    location: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.deliveries.push(delivery);
  writeData(data);

  res.status(201).json({ delivery });
});

app.get("/api/deliveries/:code", (req, res) => {
  const data = readData();
  const code = req.params.code.toUpperCase();
  const delivery = data.deliveries.find((item) => item.code === code);

  if (!delivery) {
    return res.status(404).json({ error: "Tracking code not found." });
  }

  res.json({ delivery });
});

io.on("connection", (socket) => {
  socket.on("join-delivery", (rawCode) => {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!code) return;

    const data = readData();
    const delivery = data.deliveries.find((item) => item.code === code);

    if (!delivery) {
      socket.emit("tracking-error", "Tracking code not found.");
      return;
    }

    socket.join(code);
    socket.emit("delivery-update", delivery);
  });

  socket.on("driver-location", (payload = {}) => {
    const code = String(payload.code || "").trim().toUpperCase();

    if (!socket.rooms.has(code)) return;

    const latitude = Number(payload.latitude);
    const longitude = Number(payload.longitude);
    const accuracy = Number(payload.accuracy);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const data = readData();
    const delivery = data.deliveries.find((item) => item.code === code);
    if (!delivery || delivery.status === "delivered") return;

    delivery.location = {
      latitude,
      longitude,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      updatedAt: new Date().toISOString()
    };

    delivery.status = "in_transit";

    const destination = delivery.organization;
    if (
      Number.isFinite(destination.latitude) &&
      Number.isFinite(destination.longitude)
    ) {
      const distance = distanceMetres(
        latitude,
        longitude,
        destination.latitude,
        destination.longitude
      );

      delivery.distanceMetres = Math.round(distance);

      if (distance <= 150 && accuracy <= 150) {
        delivery.status = "near_destination";
      }
    }

    delivery.updatedAt = new Date().toISOString();
    writeData(data);
    io.to(code).emit("delivery-update", delivery);
  });

  socket.on("confirm-delivered", (rawCode) => {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!socket.rooms.has(code)) return;

    const data = readData();
    const delivery = data.deliveries.find((item) => item.code === code);
    if (!delivery || delivery.status !== "near_destination") return;

    delivery.status = "delivered";
    delivery.updatedAt = new Date().toISOString();
    writeData(data);
    io.to(code).emit("delivery-update", delivery);
  });
});

server.listen(PORT, () => {
  console.log(`FoodBridge is running at http://localhost:${PORT}`);
});
