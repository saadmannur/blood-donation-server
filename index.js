require("dotenv").config();

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();

const PORT = Number(process.env.PORT) || 5000;
const MONGO_DB_URI = process.env.MONGO_DB_URI;
const DB_NAME = process.env.DB_NAME || "blood-donation";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

if (!MONGO_DB_URI) {
  throw new Error("MONGO_DB_URI is missing from .env");
}

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: "1mb" }));

const client = new MongoClient(MONGO_DB_URI);

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const RECEIVE_FROM = {
  "A+": ["A+", "A-", "O+", "O-"],
  "A-": ["A-", "O-"],
  "B+": ["B+", "B-", "O+", "O-"],
  "B-": ["B-", "O-"],
  "AB+": ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"],
  "AB-": ["A-", "B-", "AB-", "O-"],
  "O+": ["O+", "O-"],
  "O-": ["O-"],
};

const OPEN_STATUSES = ["pending", "matching", "donor_contacted"];
const FINAL_STATUSES = ["fulfilled", "cancelled"];
const ALL_STATUSES = [...OPEN_STATUSES, ...FINAL_STATUSES];
const URGENCIES = ["normal", "urgent", "critical"];
const AVAILABILITY = ["available", "unavailable"];
const VERIFICATION = ["pending", "approved", "rejected"];
const MIN_DONATION_GAP_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const PHONE_REGEX = /^(\+?88)?01[3-9]\d{8}$/;

let db;
let donorCollection;
let userCollection;
let requestCollection;
let responseCollection;
let donationCollection;
let notificationCollection;
let activityCollection;
let contactCollection;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const toId = (value) =>
  typeof value === "string" && /^[a-f\d]{24}$/i.test(value)
    ? new ObjectId(value)
    : null;

const sendError = (res, status, message) =>
  res.status(status).json({ message });
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalize = (value) => text(value).toLowerCase();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const donorView = (donor) => ({
  _id: donor._id,
  name: donor.name || "",
  email: donor.email || "",
  phone: donor.phone || "",
  bloodGroup: donor.bloodGroup,
  city: donor.city,
  area: donor.area,
  lastDonationDate: donor.lastDonationDate || null,
  availability: donor.availability || "available",
  verificationStatus: donor.verificationStatus || "pending",
  createdAt: donor.createdAt || null,
  updatedAt: donor.updatedAt || null,
});

const ownerView = (request) => {
  if (!request) return null;
  const { cityKey, patientKey, ...visible } = request;
  return visible;
};

const publicRequestView = (request) => ({
  _id: request._id,
  patientName: request.patientName,
  bloodGroup: request.bloodGroup,
  urgency: request.urgency,
  bagsRequired: request.bagsRequired,
  hospitalName: request.hospitalName,
  hospitalAddress: request.hospitalAddress,
  city: request.city,
  requiredDate: request.requiredDate,
  status: request.status,
});

const logActivity = async (message, type = "general") => {
  try {
    await activityCollection.insertOne({
      message,
      type,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error("Activity log failed:", error.message);
  }
};

const changeRequestStatus = async (requestId, status, note) => {
  const now = new Date();
  const result = await requestCollection.updateOne(
    { _id: requestId, status: { $ne: status } },
    {
      $set: { status, updatedAt: now },
      $push: { statusHistory: { status, at: now, note } },
    },
  );
  return result.modifiedCount === 1;
};

const getMailTransporter = async () => {
  if (process.env.MAIL_MODE === "json") {
    return nodemailer.createTransport({ jsonTransport: true });
  }

  const account = await nodemailer.createTestAccount();
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.pass },
  });
};

let mailTransporterPromise;
const sendMail = async ({ to, subject, text: message }) => {
  if (!to) return null;

  if (!mailTransporterPromise) {
    mailTransporterPromise = getMailTransporter();
  }

  const transporter = await mailTransporterPromise;
  const info = await transporter.sendMail({
    from: '"BloodLink" <no-reply@bloodlink.test>',
    to,
    subject,
    text: message,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) console.log("Email preview:", previewUrl);

  return info;
};

const sendMockSms = (phone, message) => {
  if (phone) console.log(`[MOCK SMS] ${phone}: ${message}`);
};

const donorCanGiveFor = (recipientBloodGroup) =>
  RECEIVE_FROM[recipientBloodGroup] || [];

const getLastDonationCutoff = () =>
  new Date(Date.now() - MIN_DONATION_GAP_DAYS * DAY);

const findMatchingDonors = async (request) => {
  const donors = await donorCollection
    .find({
      verificationStatus: "approved",
      availability: "available",
      cityKey: request.cityKey,
      bloodGroup: { $in: donorCanGiveFor(request.bloodGroup) },
      $or: [
        { lastDonationDate: null },
        { lastDonationDate: { $exists: false } },
        { lastDonationDate: { $lte: getLastDonationCutoff() } },
      ],
    })
    .toArray();

  const hospitalAddress = normalize(request.hospitalAddress);
  const score = (donor) =>
    (donor.bloodGroup === request.bloodGroup ? 2 : 0) +
    (donor.areaKey && hospitalAddress.includes(donor.areaKey) ? 1 : 0);

  return donors.sort((a, b) => score(b) - score(a));
};

const notifyMatchingDonors = async (request, donors) => {
  let notified = 0;

  for (const donor of donors) {
    if (donor.email) {
      try {
        const claim = await notificationCollection.updateOne(
          { donorId: donor._id, requestId: request._id, type: "email" },
          {
            $setOnInsert: {
              donorId: donor._id,
              requestId: request._id,
              type: "email",
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );

        if (claim.upsertedCount === 1) {
          await sendMail({
            to: donor.email,
            subject: `${request.bloodGroup} blood needed in ${request.city}`,
            text:
              `Hello ${donor.name || "Donor"},\n\n` +
              `${request.bloodGroup} blood is needed at ${request.hospitalName}, ${request.city}.\n` +
              `Urgency: ${request.urgency}. Required bags: ${request.bagsRequired}.\n\n` +
              `Please visit: ${CLIENT_URL}/find-donors`,
          });

          await notificationCollection.updateOne(
            { donorId: donor._id, requestId: request._id, type: "email" },
            { $set: { deliveryStatus: "sent", sentAt: new Date() } },
          );
          notified += 1;
        }
      } catch (error) {
        console.error("Donor email failed:", error.message);
        await notificationCollection.updateOne(
          { donorId: donor._id, requestId: request._id, type: "email" },
          { $set: { deliveryStatus: "failed", error: error.message } },
        );
      }
    }

    if (donor.phone) {
      sendMockSms(
        donor.phone,
        `${request.bloodGroup} blood needed at ${request.hospitalName}, ${request.city}.`,
      );
    }
  }

  return notified;
};

const runMatching = async (requestId) => {
  const request = await requestCollection.findOne({ _id: requestId });
  if (!request || FINAL_STATUSES.includes(request.status)) return;

  await changeRequestStatus(
    requestId,
    "matching",
    "Searching for compatible donors",
  );

  const donors = await findMatchingDonors(request);
  const notified = await notifyMatchingDonors(request, donors);

  if (notified > 0) {
    await changeRequestStatus(
      requestId,
      "donor_contacted",
      `${notified} matching donor(s) notified`,
    );
  }

  await logActivity(
    `Matching for ${request.bloodGroup} in ${request.city}: ${donors.length} donor(s) found`,
    "matching",
  );
};

const validateDonor = (body = {}, partial = false) => {
  const data = {};
  const has = (key) => !partial || body[key] !== undefined;

  for (const [key, label, min, max] of [
    ["name", "Name", 2, 80],
    ["email", "Email", 5, 150],
    ["phone", "Phone", 11, 15],
    ["city", "City", 2, 60],
    ["area", "Area", 2, 80],
  ]) {
    if (!has(key)) continue;
    const value = text(body[key]);
    if (value.length < min || value.length > max) {
      return { error: `${label} must be ${min}-${max} characters` };
    }
    data[key] = value;
  }

  if (has("email") && !/^\S+@\S+\.\S+$/.test(data.email)) {
    return { error: "Enter a valid email address" };
  }

  // if (has("phone") && !PHONE_REGEX.test(data.phone)) {
  //   return { error: "Enter a valid Bangladeshi phone number" };
  // }

  if (has("bloodGroup")) {
    if (!BLOOD_GROUPS.includes(body.bloodGroup)) {
      return { error: "Select a valid blood group" };
    }
    data.bloodGroup = body.bloodGroup;
  }

  // if (has("lastDonationDate")) {
  //   if (!body.lastDonationDate) {
  //     data.lastDonationDate = null;
  //   } else {
  //     const date = parseDate(body.lastDonationDate);
  //     if (!date || date > new Date()) {
  //       return { error: "Enter a valid last donation date" };
  //     }
  //     data.lastDonationDate = date;
  //   }
  // }

  if (has("availability")) {
    if (!AVAILABILITY.includes(body.availability)) {
      return { error: "Availability must be available or unavailable" };
    }
    data.availability = body.availability;
  }

  if (data.city) data.cityKey = normalize(data.city);
  if (data.area) data.areaKey = normalize(data.area);

  return { data };
};

const validateRequest = (body = {}, partial = false) => {
  const data = {};
  const has = (key) => !partial || body[key] !== undefined;

  for (const [key, label, min, max] of [
    ["patientName", "Patient name", 2, 100],
    ["hospitalName", "Hospital name", 2, 150],
    ["hospitalAddress", "Hospital address", 3, 250],
    ["city", "City", 2, 60],
    ["contactPerson", "Contact person", 2, 100],
  ]) {
    if (!has(key)) continue;
    const value = text(body[key]);

    if (has("patientId")) {
      const patientId = text(body.patientId);

      if (!patientId) {
        return { error: "Patient ID is required" };
      }

      data.patientId = patientId;
    }
    if (value.length < min || value.length > max) {
      return { error: `${label} must be ${min}-${max} characters` };
    }
    data[key] = value;
  }

  

  if (has("bloodGroup")) {
    if (!BLOOD_GROUPS.includes(body.bloodGroup)) {
      return { error: "Select a valid blood group" };
    }
    data.bloodGroup = body.bloodGroup;
  }

  // Optional requester email, used to notify the requester when a donor responds.
  if (body.contactEmail !== undefined) {
    const contactEmail = text(body.contactEmail);

    if (contactEmail && !/^\\S+@\\S+\\.\\S+$/.test(contactEmail)) {
      return { error: "Enter a valid contact email" };
    }

    data.contactEmail = contactEmail;
  } else if (!partial) {
    data.contactEmail = "";
  }

  if (has("bagsRequired")) {
    const bags = Number(body.bagsRequired);
    if (!Number.isInteger(bags) || bags < 1 || bags > 20) {
      return { error: "Blood bags must be between 1 and 20" };
    }
    data.bagsRequired = bags;
  }

  if (has("requiredDate")) {
    const date = parseDate(body.requiredDate);
    if (!date || date < new Date(Date.now() - 2 * DAY)) {
      return { error: "Enter a valid required date" };
    }
    data.requiredDate = date;
  }

  if (has("urgency")) {
    if (!URGENCIES.includes(body.urgency)) {
      return { error: "Urgency must be normal, urgent or critical" };
    }
    data.urgency = body.urgency;
  }

  if (body.additionalInformation !== undefined) {
    data.additionalInformation = text(body.additionalInformation).slice(0, 500);
  } else if (!partial) {
    data.additionalInformation = "";
  }

  if (data.city) data.cityKey = normalize(data.city);
  if (data.patientName) data.patientKey = normalize(data.patientName);

  return { data };
};

const findRequestOrRespond = async (idValue, res) => {
  const id = toId(idValue);
  if (!id) {
    sendError(res, 400, "Invalid request id");
    return null;
  }

  const request = await requestCollection.findOne({ _id: id });
  if (!request) {
    sendError(res, 404, "Blood request not found");
    return null;
  }

  return request;
};

// -----------------------------
// Donor APIs
// -----------------------------

app.get(
  "/api/donors",
  asyncHandler(async (req, res) => {
    const filter = {
      verificationStatus: "approved",
      availability: "available",
    };

    const bloodGroup = text(req.query.bloodGroup);
    const city = text(req.query.city);
    const area = text(req.query.area);

    if (bloodGroup) {
      if (!BLOOD_GROUPS.includes(bloodGroup)) {
        return sendError(res, 400, "Invalid blood group");
      }
      filter.bloodGroup = bloodGroup;
    }

    if (city) filter.cityKey = normalize(city);
    if (area) filter.areaKey = { $regex: escapeRegex(normalize(area)) };

    const donors = await donorCollection
      .find(filter, {
        projection: {
          name: 1,
          bloodGroup: 1,
          city: 1,
          area: 1,
          availability: 1,
          verificationStatus: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    res.json(donors);
  }),
);

app.post(
  "/api/donors",
  asyncHandler(async (req, res) => {
    const { data, error } = validateDonor(req.body);
    if (error) return sendError(res, 400, error);
    console.log(data, error);

    const duplicate = await donorCollection.findOne({
      $or: [{ email: data.email }, { phone: data.phone }],
    });

    if (duplicate) {
      return sendError(
        res,
        409,
        "A donor with this email or phone already exists",
      );
    }

    const now = new Date();
    const donor = {
      ...data,
      lastDonationDate: data.lastDonationDate || null,
      availability: data.availability || "available",
      verificationStatus: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const result = await donorCollection.insertOne(donor);
    await logActivity(`${donor.name} registered as a donor`, "donor");

    res.status(201).json(donorView({ ...donor, _id: result.insertedId }));
  }),
);

app.get(
  "/api/donors/:id",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid donor id");

    const donor = await donorCollection.findOne({ _id: id });
    if (!donor) return sendError(res, 404, "Donor not found");

    res.json(donorView(donor));
  }),
);
app.get(
  "/api/donors/email/:email",
  asyncHandler(async (req, res) => {
    const email = req.params.email.trim().toLowerCase();

    const donor = await donorCollection.findOne({ email: email });
    // console.log(donor);

    if (!donor) {
      return res.status(404).json({
        success: false,
        message: "Donor not found",
      });
    }

    res.json(donorView(donor));
  }),
);

app.patch(
  "/api/donors/:id",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid donor id");

    const donor = await donorCollection.findOne({ _id: id });
    if (!donor) return sendError(res, 404, "Donor not found");

    const { data, error } = validateDonor(req.body, true);
    if (error) return sendError(res, 400, error);
    if (!Object.keys(data).length)
      return sendError(res, 400, "Nothing to update");

    const email = data.email || donor.email;
    const phone = data.phone || donor.phone;
    const duplicate = await donorCollection.findOne({
      _id: { $ne: id },
      $or: [{ email }, { phone }],
    });

    if (duplicate) {
      return sendError(
        res,
        409,
        "Another donor already uses this email or phone",
      );
    }

    const bloodGroupChanged =
      data.bloodGroup && data.bloodGroup !== donor.bloodGroup;

    if (donor.verificationStatus === "rejected" || bloodGroupChanged) {
      data.verificationStatus = "pending";
    }

    data.updatedAt = new Date();

    await donorCollection.updateOne({ _id: id }, { $set: data });
    const updatedDonor = await donorCollection.findOne({ _id: id });

    res.json(donorView(updatedDonor));
  }),
);

app.patch(
  "/api/donors/:id/availability",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const availability = req.body?.availability;

    if (!id) return sendError(res, 400, "Invalid donor id");
    if (!AVAILABILITY.includes(availability)) {
      return sendError(
        res,
        400,
        "Availability must be available or unavailable",
      );
    }

    const result = await donorCollection.updateOne(
      { _id: id },
      { $set: { availability, updatedAt: new Date() } },
    );

    if (!result.matchedCount) return sendError(res, 404, "Donor not found");
    res.json({ success: true, availability });
  }),
);

// -----------------------------
// Admin donor verification APIs
// -----------------------------

app.get("/api/admin/users", asyncHandler(async (req, res) => {
  const result = await userCollection
    .find()
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result)
}));

app.patch(
  "/api/admin/users/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { status } = req.body;
    const query = {
      _id: new ObjectId(id),
    };
    const updateDoc = {
      $set: {
        status: status,
      },
    };

    const result = await userCollection.updateOne(query, updateDoc);
    res.send(result);
  }),
);

app.get(
  "/api/admin/donors",
  asyncHandler(async (req, res) => {
    const status = text(req.query.status);
    const filter = {};

    if (status) {
      if (!VERIFICATION.includes(status)) {
        return sendError(res, 400, "Invalid verification status");
      }
      filter.verificationStatus = status;
    }

    const donors = await donorCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    res.json(donors.map(donorView));
  }),
);

app.get(
  "/api/admin/donors/pending",
  asyncHandler(async (req, res) => {
    const donors = await donorCollection
      .find({ verificationStatus: "pending" })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    res.json(donors.map(donorView));
  }),
);

app.patch(
  "/api/admin/donors/:id/verify",
  asyncHandler(async (req, res) => {
    const id = toId(req.params.id);
    const status = req.body?.status;

    if (!id) return sendError(res, 400, "Invalid donor id");
    if (!["approved", "rejected"].includes(status)) {
      return sendError(res, 400, "Status must be approved or rejected");
    }

    const result = await donorCollection.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          verificationStatus: status,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );

    if (!result) return sendError(res, 404, "Donor not found");

    await logActivity(`${result.name || "A donor"} was ${status}`, "donor");
    res.json(donorView(result));
  }),
);

// -----------------------------
// Blood request APIs
// -----------------------------

app.post(
  "/api/requests",
  asyncHandler(async (req, res) => {
    const { data, error } = validateRequest(req.body);
    if (error) return sendError(res, 400, error);

    const duplicate = await requestCollection.findOne({
      patientKey: data.patientKey,
      bloodGroup: data.bloodGroup,
      status: { $in: OPEN_STATUSES },
    });

    if (duplicate) {
      return sendError(
        res,
        409,
        "An open request already exists for this patient and blood group",
      );
    }

    const now = new Date();
    const request = {
      ...data,
      status: "pending",
      bagsFulfilled: 0,
      statusHistory: [{ status: "pending", at: now, note: "Request created" }],
      createdAt: now,
      updatedAt: now,
    };

    const result = await requestCollection.insertOne(request);
    const savedRequest = { ...request, _id: result.insertedId };

    await logActivity(
      `${request.patientName} requested ${request.bloodGroup} blood in ${request.city}`,
      "request",
    );

    res.status(201).json(ownerView(savedRequest));

    setImmediate(() => {
      runMatching(result.insertedId).catch((error) => {
        console.error("Donor matching failed:", error);
      });
    });
  }),
);

app.get(
  "/api/requests",
  asyncHandler(async (req, res) => {
    const filter = {};
    const status = text(req.query.status);
    console.log(status);
    const city = text(req.query.city);
    const bloodGroup = text(req.query.bloodGroup);

    if (status) {
      if (!ALL_STATUSES.includes(status))
        return sendError(res, 400, "Invalid status");
      filter.status = status;
    } else {
      filter.status = { $in: OPEN_STATUSES };
    }

    if (city) filter.cityKey = normalize(city);
    if (bloodGroup) {
      if (!BLOOD_GROUPS.includes(bloodGroup)) {
        return sendError(res, 400, "Invalid blood group");
      }
      filter.bloodGroup = bloodGroup;
    }

    const items = await requestCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(300)
      .toArray();

    res.json(items.map(publicRequestView));
  }),
);

app.get(
  "/api/requests/my",
  asyncHandler(async (req, res) => {
    // Public mode: optionally filter by patientName.
    const patientId = text(req.query.patientId);
    const filter = { patientId };
    const items = await requestCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(300)
      .toArray();

    res.json(items.map(ownerView));
  }),
);

app.get(
  "/api/requests/:id",
  asyncHandler(async (req, res) => {
    const request = await findRequestOrRespond(req.params.id, res);
    if (!request) return;

    const [notifiedCount, interested, notAvailable] = await Promise.all([
      notificationCollection.countDocuments({
        requestId: request._id,
        type: "email",
        deliveryStatus: "sent",
      }),
      responseCollection.countDocuments({
        requestId: request._id,
        response: "interested",
      }),
      responseCollection.countDocuments({
        requestId: request._id,
        response: "not_available",
      }),
    ]);

    res.json({
      ...ownerView(request),
      notifiedCount,
      responseCounts: { interested, not_available: notAvailable },
    });
  }),
);

app.patch(
  "/api/requests/:id",
  asyncHandler(async (req, res) => {
    const request = await findRequestOrRespond(req.params.id, res);
    if (!request) return;

    if (FINAL_STATUSES.includes(request.status)) {
      return sendError(
        res,
        400,
        `A ${request.status} request cannot be edited`,
      );
    }

    const { data, error } = validateRequest(req.body, true);
    if (error) return sendError(res, 400, error);
    if (!Object.keys(data).length)
      return sendError(res, 400, "Nothing to update");

    data.updatedAt = new Date();

    await requestCollection.updateOne(
      { _id: request._id },
      {
        $set: data,
        $push: {
          statusHistory: {
            status: request.status,
            at: new Date(),
            note: "Request details updated",
          },
        },
      },
    );

    const changed =
      (data.bloodGroup && data.bloodGroup !== request.bloodGroup) ||
      (data.cityKey && data.cityKey !== request.cityKey);

    if (changed) {
      setImmediate(() => runMatching(request._id).catch(console.error));
    }

    res.json(ownerView(await requestCollection.findOne({ _id: request._id })));
  }),
);

app.patch(
  "/api/requests/:id/cancel",
  asyncHandler(async (req, res) => {
    const request = await findRequestOrRespond(req.params.id, res);
    if (!request) return;

    if (FINAL_STATUSES.includes(request.status)) {
      return sendError(res, 400, "This request is already closed");
    }

    await changeRequestStatus(request._id, "cancelled", "Cancelled");
    await logActivity(
      `Request for ${request.bloodGroup} blood (${request.patientName}) was cancelled`,
      "request",
    );

    res.json(ownerView(await requestCollection.findOne({ _id: request._id })));
  }),
);

// -----------------------------
// Matching and donor response APIs
// -----------------------------

app.get(
  "/api/matching/:requestId",
  asyncHandler(async (req, res) => {
    const request = await findRequestOrRespond(req.params.requestId, res);
    if (!request) return;

    const [matchedDonors, responses] = await Promise.all([
      findMatchingDonors(request),
      responseCollection.find({ requestId: request._id }).toArray(),
    ]);

    const donorIds = new Set(matchedDonors.map((donor) => String(donor._id)));
    const extraIds = responses
      .filter((response) => !donorIds.has(String(response.donorId)))
      .map((response) => response.donorId);

    const extraDonors = extraIds.length
      ? await donorCollection.find({ _id: { $in: extraIds } }).toArray()
      : [];

    const allDonors = [...matchedDonors, ...extraDonors];

    const rows = allDonors.map((donor) => {
      const response = responses.find(
        (item) => String(item.donorId) === String(donor._id),
      );

      return {
        donorId: donor._id,
        name: donor.name || "",
        email: donor.email || "",
        phone: donor.phone || "",
        bloodGroup: donor.bloodGroup,
        city: donor.city,
        area: donor.area,
        availability: donor.availability,
        verificationStatus: donor.verificationStatus,
        response: response?.response || null,
      };
    });

    rows.sort((a, b) => {
      const order = { interested: 0, null: 1, not_available: 2 };
      return order[a.response] - order[b.response];
    });

    res.json(rows);
  }),
);

app.post(
  "/api/responses",
  asyncHandler(async (req, res) => {
    const donorId = toId(req.body?.donorId);
    const requestId = toId(req.body?.requestId);
    const response = req.body?.response;

    if (!donorId || !requestId) {
      return sendError(res, 400, "Valid donorId and requestId are required");
    }
    if (!["interested", "not_available"].includes(response)) {
      return sendError(
        res,
        400,
        "Response must be interested or not_available",
      );
    }

    const [donor, request] = await Promise.all([
      donorCollection.findOne({ _id: donorId }),
      requestCollection.findOne({ _id: requestId }),
    ]);

    if (!donor) return sendError(res, 404, "Donor not found");
    if (!request) return sendError(res, 404, "Blood request not found");

    if (
      donor.verificationStatus !== "approved" ||
      donor.availability !== "available"
    ) {
      return sendError(res, 403, "Donor must be approved and available");
    }

    if (FINAL_STATUSES.includes(request.status)) {
      return sendError(res, 400, "This request is closed");
    }

    if (
      donor.cityKey !== request.cityKey ||
      !donorCanGiveFor(request.bloodGroup).includes(donor.bloodGroup)
    ) {
      return sendError(
        res,
        403,
        "This request does not match the donor's blood group or city",
      );
    }

    if (response === "interested" && donor.lastDonationDate) {
      const nextEligibleDate = new Date(
        new Date(donor.lastDonationDate).getTime() +
          MIN_DONATION_GAP_DAYS * DAY,
      );

      if (nextEligibleDate > new Date()) {
        return sendError(
          res,
          400,
          `Donor can donate again from ${nextEligibleDate.toISOString().slice(0, 10)}`,
        );
      }
    }

    const now = new Date();
    await responseCollection.updateOne(
      { donorId, requestId },
      {
        $set: { response, respondedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );

    if (response === "interested") {
      await changeRequestStatus(
        requestId,
        "donor_contacted",
        "A donor responded as interested",
      );

      if (request.contactEmail) {
        sendMail({
          to: request.contactEmail,
          subject: `A donor is interested in your ${request.bloodGroup} request`,
          text: `${donor.name} is interested in donating for ${request.patientName}.`,
        }).catch((error) =>
          console.error("Requester email failed:", error.message),
        );
      }
    }

    await logActivity(
      `${donor.name} responded "${response}" to a ${request.bloodGroup} request`,
      "response",
    );

    res.status(201).json({ success: true, response });
  }),
);

app.get(
  "/api/responses/my",
  asyncHandler(async (req, res) => {
    const donorId = toId(req.query.donorId);
    if (!donorId) return sendError(res, 400, "Provide a valid donorId");

    const responses = await responseCollection
      .find({ donorId })
      .sort({ respondedAt: -1 })
      .toArray();

    const requests = responses.length
      ? await requestCollection
          .find({ _id: { $in: responses.map((item) => item.requestId) } })
          .toArray()
      : [];

    res.json(
      responses
        .map((response) => {
          const request = requests.find(
            (item) => String(item._id) === String(response.requestId),
          );
          if (!request) return null;

          return {
            _id: response._id,
            requestId: response.requestId,
            response: response.response,
            respondedAt: response.respondedAt,
            patientName: request.patientName,
            bloodGroup: request.bloodGroup,
            hospitalName: request.hospitalName,
            city: request.city,
            requestStatus: request.status,
          };
        })
        .filter(Boolean),
    );
  }),
);

// -----------------------------
// Donation APIs
// -----------------------------

app.post(
  "/api/donations",
  asyncHandler(async (req, res) => {
    const donorId = toId(req.body?.donorId);
    const requestId = toId(req.body?.requestId);

    if (!donorId || !requestId) {
      return sendError(res, 400, "Valid donorId and requestId are required");
    }

    const [donor, request, interested] = await Promise.all([
      donorCollection.findOne({ _id: donorId }),
      requestCollection.findOne({ _id: requestId }),
      responseCollection.findOne({
        donorId,
        requestId,
        response: "interested",
      }),
    ]);

    if (!donor) return sendError(res, 404, "Donor not found");
    if (!request) return sendError(res, 404, "Blood request not found");
    if (!interested)
      return sendError(res, 400, "Donor has not responded as interested");
    if (FINAL_STATUSES.includes(request.status)) {
      return sendError(res, 400, `This request is already ${request.status}`);
    }

    const existingDonation = await donationCollection.findOne({
      donorId,
      requestId,
    });
    if (existingDonation)
      return sendError(res, 409, "Donation already confirmed");

    const now = new Date();
    const donation = {
      donorId,
      requestId,
      donorName: donor.name || "Donor",
      donorEmail: donor.email || "",
      patientName: request.patientName,
      bloodGroup: donor.bloodGroup,
      hospitalName: request.hospitalName,
      city: request.city,
      donationDate: now,
      status: "completed",
      createdAt: now,
    };

    const result = await donationCollection.insertOne(donation);

    await donorCollection.updateOne(
      { _id: donorId },
      { $set: { lastDonationDate: now, updatedAt: now } },
    );

    const fulfilledCount = await donationCollection.countDocuments({
      requestId,
    });
    await requestCollection.updateOne(
      { _id: requestId },
      { $set: { bagsFulfilled: fulfilledCount, updatedAt: now } },
    );

    let requestFulfilled = false;
    if (fulfilledCount >= request.bagsRequired) {
      requestFulfilled = await changeRequestStatus(
        requestId,
        "fulfilled",
        `All ${request.bagsRequired} blood bag(s) confirmed`,
      );
    }

    await logActivity(
      `${donation.donorName} donated ${donation.bloodGroup} blood for ${request.patientName}`,
      "donation",
    );

    res.status(201).json({
      ...donation,
      _id: result.insertedId,
      bagsFulfilled: fulfilledCount,
      requestFulfilled,
    });
  }),
);

app.get(
  "/api/donations/my",
  asyncHandler(async (req, res) => {
    const donorId = toId(req.query.donorId);
    if (!donorId) return sendError(res, 400, "Provide a valid donorId");

    const donations = await donationCollection
      .find({ donorId })
      .sort({ donationDate: -1 })
      .toArray();

    res.json(donations);
  }),
);

// -----------------------------
// Admin dashboard and reporting APIs
// -----------------------------

app.get(
  "/api/admin/dashboard",
  asyncHandler(async (req, res) => {
    const [
      totalDonors,
      totalUsers,
      approvedDonors,
      pendingDonors,
      rejectedDonors,
      totalRequests,
      pendingRequests,
      completedRequests,
      cancelledRequests,
      recentActivities,
    ] = await Promise.all([
      donorCollection.countDocuments({}),
      userCollection.countDocuments({}),
      donorCollection.countDocuments({ verificationStatus: "approved" }),
      donorCollection.countDocuments({ verificationStatus: "pending" }),
      donorCollection.countDocuments({ verificationStatus: "rejected" }),
      requestCollection.countDocuments({}),
      requestCollection.countDocuments({ status: { $in: OPEN_STATUSES } }),
      requestCollection.countDocuments({ status: "fulfilled" }),
      requestCollection.countDocuments({ status: "cancelled" }),
      activityCollection.find({}).sort({ createdAt: -1 }).limit(10).toArray(),
    ]);

    res.json({
      totalDonors,
      totalUsers,
      approvedDonors,
      verifiedDonors: approvedDonors,
      pendingDonors,
      rejectedDonors,
      totalRequests,
      pendingRequests,
      completedRequests,
      cancelledRequests,
      recentActivities,
    });
  }),
);

app.get(
  "/api/admin/reports",
  asyncHandler(async (req, res) => {
    const countBy = async (collection, match, field) => {
      const rows = await collection
        .aggregate([
          { $match: match },
          { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        ])
        .toArray();

      return new Map(rows.map((row) => [row._id, row.count]));
    };

    const withZeros = (labels, counts) =>
      labels.map((label) => ({ label, count: counts.get(label) || 0 }));

    const [byGroup, byCity, byStatus, byUrgency, totalDonations] =
      await Promise.all([
        countBy(
          donorCollection,
          { verificationStatus: "approved" },
          "bloodGroup",
        ),
        countBy(donorCollection, { verificationStatus: "approved" }, "cityKey"),
        countBy(requestCollection, {}, "status"),
        countBy(requestCollection, {}, "urgency"),
        donationCollection.countDocuments({}),
      ]);

    res.json({
      totalDonations,
      donorsByBloodGroup: withZeros(BLOOD_GROUPS, byGroup),
      donorsByCity: [...byCity.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([city, count]) => ({
          label: String(city || "Unknown").replace(/\b\w/g, (char) =>
            char.toUpperCase(),
          ),
          count,
        })),
      requestsByStatus: withZeros(ALL_STATUSES, byStatus),
      requestsByUrgency: withZeros(URGENCIES, byUrgency),
    });
  }),
);

app.get(
  "/api/admin/requests",
  asyncHandler(async (req, res) => {
    const requests = await requestCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    res.json(requests.map(ownerView));
  }),
);

app.patch(
  "/api/admin/requests/:id/status",
  asyncHandler(async (req, res) => {
    const request = await findRequestOrRespond(req.params.id, res);
    if (!request) return;

    const status = req.body?.status;
    if (!ALL_STATUSES.includes(status)) {
      return sendError(res, 400, "Invalid request status");
    }

    if (request.status !== status) {
      await changeRequestStatus(request._id, status, "Status updated by admin");
      await logActivity(
        `Admin changed ${request.bloodGroup} request for ${request.patientName} to ${status}`,
        "request",
      );
    }

    res.json(ownerView(await requestCollection.findOne({ _id: request._id })));
  }),
);

app.delete(
  "/api/admin/requests/:id",
  asyncHandler(async (req, res) => {
    const request = await findRequestOrRespond(req.params.id, res);
    if (!request) return;

    const donationExists = await donationCollection.findOne({
      requestId: request._id,
    });

    if (donationExists) {
      return sendError(
        res,
        409,
        "This request has donations and cannot be deleted",
      );
    }

    await Promise.all([
      responseCollection.deleteMany({ requestId: request._id }),
      notificationCollection.deleteMany({ requestId: request._id }),
      requestCollection.deleteOne({ _id: request._id }),
    ]);

    await logActivity(
      `Admin removed ${request.bloodGroup} request for ${request.patientName}`,
      "request",
    );

    res.json({ success: true });
  }),
);

app.get(
  "/api/admin/donations",
  asyncHandler(async (req, res) => {
    const donations = await donationCollection
      .find({})
      .sort({ donationDate: -1 })
      .limit(500)
      .toArray();

    res.json(donations);
  }),
);

app.get(
  "/api/admin/activities",
  asyncHandler(async (req, res) => {
    const activities = await activityCollection
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json(activities);
  }),
);

// -----------------------------
// Contact API
// -----------------------------

app.post(
  "/api/contact",
  asyncHandler(async (req, res) => {
    const name = text(req.body?.name);
    const email = text(req.body?.email);
    const subject = text(req.body?.subject);
    const message = text(req.body?.message);

    if (name.length < 2) return sendError(res, 400, "Name is required");
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return sendError(res, 400, "Enter a valid email");
    }
    if (subject.length < 2) return sendError(res, 400, "Subject is required");
    if (message.length < 10 || message.length > 2000) {
      return sendError(res, 400, "Message must be 10 to 2000 characters");
    }

    await contactCollection.insertOne({
      name,
      email,
      subject,
      message,
      createdAt: new Date(),
    });

    if (process.env.ADMIN_EMAIL) {
      sendMail({
        to: process.env.ADMIN_EMAIL,
        subject: `Contact form: ${subject}`,
        text: `From: ${name} <${email}>\n\n${message}`,
      }).catch((error) =>
        console.error("Contact email failed:", error.message),
      );
    }

    res.status(201).json({ success: true, message: "Message received" });
  }),
);

// -----------------------------
// Health check, 404 and errors
// -----------------------------

app.get("/", (req, res) => {
  res.json({ success: true, message: "Blood Donation API is running" });
});

app.use((req, res) => {
  sendError(res, 404, "Route not found");
});

app.use((error, req, res, next) => {
  console.error("API error:", error);

  if (error.code === 11000) {
    return sendError(res, 409, "A record with this information already exists");
  }

  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return sendError(res, 400, "Invalid JSON body");
  }

  sendError(res, 500, "Internal server error");
});

// -----------------------------
// Database connection and server
// -----------------------------

const startServer = async () => {
  try {
    await client.connect();
    db = client.db(DB_NAME);

    donorCollection = db.collection("donor");
    userCollection = db.collection("user");
    requestCollection = db.collection("bloodRequests");
    responseCollection = db.collection("donorResponses");
    donationCollection = db.collection("donations");
    notificationCollection = db.collection("notifications");
    activityCollection = db.collection("activities");
    contactCollection = db.collection("contactMessages");

    // No unique userId index: donor records do not require userId.
    // These indexes support lookups and prevent duplicate responses/donations.
    await Promise.all([
      donorCollection.createIndex({
        verificationStatus: 1,
        cityKey: 1,
        bloodGroup: 1,
      }),
      donorCollection.createIndex({ email: 1 }),
      donorCollection.createIndex({ phone: 1 }),
      requestCollection.createIndex({ status: 1, createdAt: -1 }),
      requestCollection.createIndex({ cityKey: 1, bloodGroup: 1 }),
      responseCollection.createIndex(
        { donorId: 1, requestId: 1 },
        { unique: true },
      ),
      notificationCollection.createIndex(
        { donorId: 1, requestId: 1, type: 1 },
        { unique: true },
      ),
      donationCollection.createIndex(
        { donorId: 1, requestId: 1 },
        { unique: true },
      ),
    ]);

    app.listen(PORT, () => {
      console.log(`Blood Donation API listening on port ${PORT}`);
      console.log(`Connected to MongoDB database: ${DB_NAME}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    await client.close().catch(() => {});
    process.exit(1);
  }
};

process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  await client.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await client.close();
  process.exit(0);
});

startServer();