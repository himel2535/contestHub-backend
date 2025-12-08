require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const port = process.env.PORT || 3000;

// Firebase setup
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf-8");
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// Middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// JWT middleware
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// MongoDB setup
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("contests_db");
    const contestsCollection = db.collection("contests");
    const ordersCollection = db.collection("orders");
    const submissionsCollection = db.collection("submissions");

    // Get all contests
    app.get("/contests", async (req, res) => {
      const result = await contestsCollection.find().toArray();
      res.send(result);
    });

    // Get single contest
    app.get("/contest/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await contestsCollection.findOne({ _id: new ObjectId(id) });
        if (!result) return res.status(404).send({ error: "Contest not found" });
        if (result.deadline) result.deadline = result.deadline.toISOString();
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to fetch contest" });
      }
    });

    // Create contest
    app.post("/contests", async (req, res) => {
      try {
        const data = req.body;
        const doc = {
          image: data.image,
          name: data.name,
          description: data.description,
          participantsCount: Number(data.participantsCount) || 0,
          prizeMoney: Number(data.prizeMoney) || 0,
          contestFee: Number(data.contestFee) || 0,
          category: data.category,
          contestCreator: data.contestCreator || {},
          participants: data.participants || [],
          deadline: data.deadline ? new Date(data.deadline) : null,
          createdAt: new Date(),
        };
        const result = await contestsCollection.insertOne(doc);
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to create contest" });
      }
    });

    // Stripe checkout session
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo.name,
                description: paymentInfo.description,
                images: [paymentInfo.image],
              },
              unit_amount: paymentInfo.contestFee * 100,
            },
            quantity: paymentInfo.participantsCount,
          },
        ],
        customer_email: paymentInfo.participant.email,
        mode: "payment",
        metadata: {
          contestId: paymentInfo.contestId,
          participant: paymentInfo.participant.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}&contestId=${paymentInfo.contestId}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/contest/${paymentInfo.contestId}`,
      });
      res.send({ url: session.url });
    });

    // Payment success webhook
    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const contestId = session.metadata.contestId;
        const participantEmail = session.metadata.participant;

        const contest = await contestsCollection.findOne({ _id: new ObjectId(contestId) });
        const order = await ordersCollection.findOne({ transactionId: session.payment_intent });

        if (session.status === "complete" && contest && !order) {
          const orderInfo = {
            contestId,
            transactionId: session.payment_intent,
            participant: participantEmail,
            status: "pending",
            contestCreator: contest.contestCreator,
            name: contest.name,
            category: contest.category,
            contestFee: session.amount_total / 100,
          };

          const result = await ordersCollection.insertOne(orderInfo);

          await contestsCollection.updateOne(
            { _id: new ObjectId(contestId) },
            {
              $addToSet: { participants: participantEmail },
              $inc: { participantsCount: 1 },
            }
          );

          return res.send({ transactionId: session.payment_intent, orderId: result.insertedId });
        }

        return res.send({ transactionId: session.payment_intent, orderId: order?._id });
      } catch (error) {
        res.status(500).send({ error: "Payment processing failed." });
      }
    });

    // Submit task
    app.post("/submit-task", async (req, res) => {
      const { contestId, task, email } = req.body;
      const submission = { contestId, email, task, submittedAt: new Date() };
      const result = await submissionsCollection.insertOne(submission);
      res.send(result);
    });

    // Test DB connection
    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");
  } finally {
    // Optional cleanup
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
