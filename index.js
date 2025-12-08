require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
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

    // --add contests by contest creator--
    app.post("/contests", async (req, res) => {
      const contestData = req.body;
      console.log(contestData);
      const result = await contestsCollection.insertOne(contestData);
      res.send(result);
    });

    // --get contests by user--
    app.get("/contests", async (req, res) => {
      const result = await contestsCollection.find().toArray();
      res.send(result);
    });

    // --get single contest by user--
    app.get("/contest/:id", async (req, res) => {
      const id = req.params.id;
      const result = await contestsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // --Payment endpoints
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;

      const session = await stripe.checkout.sessions.create({
 
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.contestFee * 100,
            },
            quantity: paymentInfo?.participantsCount,
          },
        ],
        customer_email: paymentInfo?.participant?.email,
        mode: "payment",
        metadata: {
          contestId: paymentInfo?.contestId,
          participant: paymentInfo?.participant?.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}&contestId=${paymentInfo.contestId}`,

        cancel_url: `${process.env.CLIENT_DOMAIN}/contest/${paymentInfo.contestId}`,
      });
      res.send({ url: session.url });
    });

    // app.post("/payment-success", async (req, res) => {
    //   const { sessionId } = req.body;
    //   const session = await stripe.checkout.sessions.retrieve(sessionId);

    //   const contest = await contestsCollection.findOne({
    //     _id: new ObjectId(session.metadata.contestId),
    //   });

    //   const order = await ordersCollection.findOne({
    //     transactionId: session.payment_intent,
    //   });

    //   console.log(session);
    //   if (session.status === "complete" && contest && !order) {
    //     const orderInfo = {
    //       contestId: session.metadata.contestId,
    //       transactionId: session.payment_intent,
    //       participant: session.metadata.participant,
    //       status: "pending",
    //       contestCreator: contest.contestCreator,
    //       name: contest.name,
    //       category: contest.category,
    //       participantCount: 1,
    //       contestFee: session.amount_total / 100,
    //     };
    //     console.log(orderInfo);
    //     const result = await ordersCollection.insertOne(orderInfo);

    //     // update participantCount
    //     await contestsCollection.updateOne(
    //       {
    //         _id: new ObjectId(session.metadata.contestId),
    //       },
    //       { $inc: { participantCount: 1 } }
    //     );
    //     return res.send({
    //       transactionId: session.payment_intent,
    //       orderId: result.insertedId,
    //     });
    //   }
    //   res.send(
    //     res.send({
    //       transactionId: session.payment_intent,
    //       orderId: order._id,
    //     })
    //   );
    // });

    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const contest = await contestsCollection.findOne({
          _id: new ObjectId(session.metadata.contestId),
        });

        const order = await ordersCollection.findOne({
          transactionId: session.payment_intent,
        });

        console.log("SESSION:", session);

        // Create new order if not exists
        if (session.status === "complete" && contest && !order) {
          const orderInfo = {
            contestId: session.metadata.contestId,
            transactionId: session.payment_intent,
            participant: session.metadata.participant,
            status: "pending",
            contestCreator: contest.contestCreator,
            name: contest.name,
            category: contest.category,
            participantsCount: 1,
            contestFee: session.amount_total / 100,
          };

          console.log("ORDER INFO:", orderInfo);

          const result = await ordersCollection.insertOne(orderInfo);

          // update participant count
          await contestsCollection.updateOne(
            { _id: new ObjectId(session.metadata.contestId) },
            { $inc: { participantsCount: 1 } }
          );

          return res.send({
            transactionId: session.payment_intent,
            orderId: result.insertedId,
          });
        }

        // If order already exists, return it
        return res.send({
          transactionId: session.payment_intent,
          orderId: order?._id,
        });
      } catch (error) {
        console.error("PAYMENT SUCCESS ERROR:", error);
        res.status(500).send({ error: "Payment processing failed." });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
