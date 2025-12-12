require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const port = process.env.PORT || 3000;

// Firebase setup
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
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
    const usersCollection = db.collection("users");
    const creatorRequestsCollection = db.collection("creatorRequests");

    // ---role middlewares---
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });

      if (user?.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Admin only Actions", role: user?.role });
      }
      next();
    };

    const verifyCREATOR = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });

      if (user?.role !== "contestCreator") {
        return res
          .status(403)
          .send({ message: "Contest Creator only Actions", role: user?.role });
      }
      next();
    };

    //--- API Endpoints ---//

    // Get all contests (USER view - confirmed and completed contests)
    app.get("/contests", async (req, res) => {
      try {
        const result = await contestsCollection
          .find({
            status: { $in: ["Confirmed", "Completed"] },
          })
          .toArray();
        res.send(result);
      } catch (err) {
        console.error("Error fetching contests for user view:", err);
        res.status(500).send({ error: "Failed to fetch contests" });
      }
    });

    // --- ADMIN MANAGEMENT ROUTES ---

    // 1. Get all contests for management (Admin only)
    app.get("/all-contests-admin", verifyJWT, verifyADMIN, async (req, res) => {
      try {
        // Find all contests regardless of status
        const result = await contestsCollection.find().toArray();
        res.send(result);
      } catch (err) {
        console.error("Error fetching all contests for admin:", err);
        res.status(500).send({ error: "Failed to fetch contests for admin" });
      }
    });

    // 2. Confirm/Approve or Reject a Contest (Admin only)
    app.patch(
      "/contest-status/:id",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body; // status: 'Confirmed' or 'Rejected'

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid Contest ID" });
          }

          // Ensure status is a valid value
          if (!["Confirmed", "Rejected"].includes(status)) {
            return res
              .status(400)
              .send({ message: "Invalid status value provided" });
          }

          const updateDoc = {
            $set: {
              status: status,
              approvedBy: req.tokenEmail,
              approvedAt: new Date(),
            },
          };

          const result = await contestsCollection.updateOne(
            { _id: new ObjectId(id) },
            updateDoc
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({ message: "Contest not found." });
          }

          res.send({
            message: `Contest status updated to ${status} successfully!`,
            result,
          });
        } catch (err) {
          console.error("Error updating contest status:", err);
          res.status(500).send({ error: "Failed to update contest status" });
        }
      }
    );

    // 3. Delete Contest by ID (Admin only - for PERMANENT DELETION)
    app.delete(
      "/contests-delete/:id",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid Contest ID" });
          }

          const result = await contestsCollection.deleteOne({
            _id: new ObjectId(id),
          });

          if (result.deletedCount === 0)
            return res.status(404).send({ message: "Contest not found" });

          // Optional: Delete related submissions and orders
          // await submissionsCollection.deleteMany({ contestId: id });
          // await ordersCollection.deleteMany({ contestId: id });

          res.send({ message: "Contest deleted successfully" });
        } catch (err) {
          res
            .status(500)
            .send({ message: "Failed to delete contest", error: err });
        }
      }
    );

    // --- END ADMIN MANAGEMENT ROUTES ---

    // Get single contest with ID validation
    app.get("/contest/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!id || id === "undefined") {
          return res
            .status(400)
            .send({ error: "Contest ID is missing or invalid." });
        }

        // 💡 ObjectId validation
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ error: "Invalid Contest ID format." });
        }

        const result = await contestsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!result)
          return res.status(404).send({ error: "Contest not found" });

        if (result.deadline && result.deadline instanceof Date) {
          result.deadline = result.deadline.toISOString();
        }

        res.send(result);
      } catch (err) {
        console.error(
          "Error fetching contest details for ID:",
          req.params.id,
          "Error:",
          err
        );
        res.status(500).send({ error: "Failed to fetch contest" });
      }
    });

    // Create contest (Contest Creator only)
    app.post("/contests", verifyJWT, verifyCREATOR, async (req, res) => {
      try {
        const data = req.body;
        const doc = {
          image: data.image,
          name: data.name,
          description: data.description,
          status: "Pending",
          participantsCount: Number(data.participantsCount) || 0,
          prizeMoney: Number(data.prizeMoney) || 0,
          contestFee: Number(data.contestFee) || 0,
          category: data.category,
          contestCreator: data.contestCreator || {},
          participants: data.participants || [],
          deadline: data.deadline ? new Date(data.deadline) : null,
          taskInstruction: data.taskInstruction || "",
          createdAt: new Date(),
        };
        const result = await contestsCollection.insertOne(doc);
        res.send(result);
      } catch (err) {
        res.status(500).send({ error: "Failed to create contest" });
      }
    });

    //  my-inventory for contest creator (used in front-end)
    app.get(
      "/my-inventory/:email",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        try {
          const email = req.params.email;

          const result = await contestsCollection
            .find({
              "contestCreator.email": email,
            })
            .toArray();
          res.send(result);
        } catch (err) {
          console.error("Error fetching creator inventory:", err);
          res.status(500).send({ error: "Failed to fetch inventory" });
        }
      }
    );

    // Update contest
    app.put(
      "/contests-update/:id",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        try {
          const { id } = req.params;
          const updatedData = req.body;

          if (
            updatedData.deadline &&
            typeof updatedData.deadline === "string"
          ) {
            updatedData.deadline = new Date(updatedData.deadline);
          }

          // Prevent creator from changing status directly
          delete updatedData.status;

          const result = await contestsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: updatedData }
          );

          res.send({ message: "Contest updated successfully!", result });
        } catch (err) {
          res
            .status(500)
            .send({ message: "Failed to update contest", error: err });
        }
      }
    );

    // Declare Contest Winner
    app.patch(
      "/contests/winner/:contestId",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        try {
          const { contestId } = req.params;
          const winnerData = req.body;

          if (!ObjectId.isValid(contestId)) {
            return res.status(400).send({ message: "Invalid Contest ID" });
          }

          const contest = await contestsCollection.findOne({
            _id: new ObjectId(contestId),
          });

          if (!contest) {
            return res.status(404).send({ message: "Contest not found." });
          }

          // Check if Already Winner Declared
          if (contest.winner) {
            return res.status(400).send({
              message: "Winner has already been declared for this contest.",
            });
          }

          // Ensure the contest is Confirmed before declaring winner
          if (contest.status !== "Confirmed") {
            return res.status(400).send({
              message: "Contest must be Confirmed to declare a winner.",
            });
          }

          const updateDoc = {
            $set: {
              winner: {
                name: winnerData.winnerName,
                email: winnerData.winnerEmail,
                photo: winnerData.winnerPhoto,
                submissionId: winnerData.submissionId,
                declaredAt: new Date(),
              },
              status: "Completed",
            },
          };

          const result = await contestsCollection.updateOne(
            { _id: new ObjectId(contestId) },
            updateDoc
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({ message: "Contest not found." });
          }

          await submissionsCollection.updateOne(
            { _id: new ObjectId(winnerData.submissionId) },
            { $set: { status: "Winner" } }
          );

          res.send({ message: "Winner declared successfully!", result });
        } catch (err) {
          console.error("Error declaring winner:", err);
          res.status(500).send({ error: "Failed to declare winner" });
        }
      }
    );

    // Contest Creator Delete Contest (Only if contest is Pending)
    app.delete(
      "/creator-contests-delete/:id",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        try {
          const { id } = req.params;
          const creatorEmail = req.tokenEmail;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid Contest ID" });
          }

          // 💡 1. Find the contest and ensure it is Pending
          const contest = await contestsCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!contest) {
            return res.status(404).send({ message: "Contest not found." });
          }

          if (contest.status !== "Pending") {
            return res.status(403).send({
              message: "Contests can only be deleted if the status is Pending.",
            });
          }

          // 💡 2. Ensure the user trying to delete is the actual creator
          if (contest.contestCreator.email !== creatorEmail) {
            return res.status(403).send({
              message: "Forbidden: You are not the creator of this contest.",
            });
          }

          // 💡 3. Proceed with deletion
          const result = await contestsCollection.deleteOne({
            _id: new ObjectId(id),
          });

          if (result.deletedCount === 0)
            return res
              .status(404)
              .send({ message: "Contest not found during deletion" });

          res.send({ message: "Contest deleted successfully by creator" });
        } catch (err) {
          console.error("Error deleting contest by creator:", err);
          res.status(500).send({
            message: "Failed to delete contest by creator",
            error: err,
          });
        }
      }
    );

    // Submit task
    app.post("/submit-task", async (req, res) => {
      const { contestId, task, email, name, photoUrl } = req.body;
      const submission = {
        contestId,
        email,
        name,
        photo: photoUrl,
        task,
        submittedAt: new Date(),
        status: "Pending",
      };
      const result = await submissionsCollection.insertOne(submission);
      res.send(result);
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
            quantity: 1,
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

        const contest = await contestsCollection.findOne({
          _id: new ObjectId(contestId),
        });
        const order = await ordersCollection.findOne({
          transactionId: session.payment_intent,
        });

        if (session.status === "complete" && contest && !order) {
          const orderInfo = {
            contestId,
            transactionId: session.payment_intent,
            participant: participantEmail,
            status: "Paid",
            contestCreator: contest.contestCreator,
            name: contest.name,
            category: contest.category,
            contestFee: session.amount_total / 100,
            image: contest.image,
          };

          const result = await ordersCollection.insertOne(orderInfo);

          await contestsCollection.updateOne(
            { _id: new ObjectId(contestId) },
            {
              $addToSet: { participants: participantEmail },
              $inc: { participantsCount: 1 },
            }
          );

          return res.send({
            transactionId: session.payment_intent,
            orderId: result.insertedId,
          });
        }

        return res.send({
          transactionId: session.payment_intent,
          orderId: order?._id,
        });
      } catch (error) {
        res.status(500).send({ error: "Payment processing failed." });
      }
    });

    // get all participation for participant
    app.get("/my-contests", verifyJWT, async (req, res) => {
      try {
        const participantEmail = req.tokenEmail;

        const result = await ordersCollection
          .aggregate([
            {
              $match: {
                participant: participantEmail,
              },
            },
            {
              $addFields: {
                contestObjectId: { $toObjectId: "$contestId" },
              },
            },
            {
              $lookup: {
                from: "contests",
                localField: "contestObjectId",
                foreignField: "_id",
                as: "contestDetails",
              },
            },
            {
              $unwind: {
                path: "$contestDetails",
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $sort: {
                "contestDetails.deadline": 1,
              },
            },
            {
              $project: {
                _id: 1,
                transactionId: 1,
                status: 1,
                name: 1,
                category: 1,
                contestFee: 1,
                image: 1,
                deadline: "$contestDetails.deadline",
              },
            },
          ])
          .toArray();

        res.send(result);
      } catch (err) {
        console.error(
          "Error fetching participant contests with deadline:",
          err
        );
        res
          .status(500)
          .send({ error: "Failed to fetch participated contests" });
      }
    });

    // get all participation manage data for contest creator
    app.get(
      "/manage-contests/:email",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        const email = req.params.email;
        const result = await ordersCollection
          .find({
            "contestCreator.email": email,
          })
          .toArray();
        res.send(result);
      }
    );

    // Get all submissions for a specific contest ID
    app.get("/contest-submissions/:contestId", async (req, res) => {
      try {
        const contestId = req.params.contestId;

        if (!contestId || contestId === "undefined") {
          return res.status(400).send({ error: "Contest ID is missing." });
        }

        const submissions = await submissionsCollection
          .find({
            contestId: contestId,
          })
          .toArray();

        res.send(submissions);
      } catch (err) {
        console.error("Error fetching contest submissions by ID:", err);
        res.status(500).send({ error: "Failed to fetch contest submissions" });
      }
    });

    // Check Submission Status (For disabling submit button)
    app.get(
      "/contest-submission-status/:contestId/:email",
      async (req, res) => {
        try {
          const { contestId, email } = req.params;

          const submission = await submissionsCollection.findOne({
            contestId: contestId,
            email: email,
          });

          if (submission) {
            res.send({ submitted: true });
          } else {
            res.send({ submitted: false });
          }
        } catch (err) {
          console.error("Error checking submission status:", err);
          res.status(500).send({ error: "Failed to check submission status" });
        }
      }
    );

    // Get all submissions for the contests created by the contest creator
    app.get(
      "/creator-submissions/:email",
      verifyJWT,
      verifyCREATOR,
      async (req, res) => {
        try {
          const creatorEmail = req.params.email;

          const creatorContests = await contestsCollection
            .find({
              "contestCreator.email": creatorEmail,
            })
            .project({ _id: 1 })
            .toArray();

          const contestIds = creatorContests.map((contest) =>
            contest._id.toString()
          );

          if (contestIds.length === 0) {
            return res.send([]);
          }

          const submissions = await submissionsCollection
            .find({
              contestId: { $in: contestIds },
            })
            .toArray();

          res.send(submissions);
        } catch (err) {
          console.error("Error fetching creator submissions:", err);
          res
            .status(500)
            .send({ error: "Failed to fetch creator submissions" });
        }
      }
    );

    // --winners in leaderboard--
    app.get("/winners-leaderboard", async (req, res) => {
      try {
        const recentWinners = await contestsCollection
          .find({ winner: { $exists: true, $ne: null } })
          .sort({ "winner.declaredAt": -1 })
          .limit(6)
          .project({
            name: 1,
            prizeMoney: 1,
            winner: 1,
            category: 1,
          })
          .toArray();

        const stats = await contestsCollection
          .aggregate([
            {
              $match: { winner: { $exists: true, $ne: null } },
            },
            {
              $group: {
                _id: null,
                totalWinners: { $sum: 1 },
                totalPrizeMoney: { $sum: "$prizeMoney" },
              },
            },
          ])
          .toArray();

        const formattedStats = stats[0] || {
          totalWinners: 0,
          totalPrizeMoney: 0,
        };

        const winnersData = recentWinners.map((contest) => ({
          contestId: contest._id,
          contestName: contest.name,
          prize: contest.prizeMoney,
          winnerName: contest.winner.name,
          winnerPhoto: contest.winner.photo,
          declaredAt: contest.winner.declaredAt,
          category: contest.category,
        }));

        res.send({
          totalWinners: formattedStats.totalWinners,
          totalPrizeMoney: formattedStats.totalPrizeMoney,
          recentWinners: winnersData,
        });
      } catch (err) {
        console.error("Error fetching leaderboard data:", err);
        res.status(500).send({ error: "Failed to fetch leaderboard data" });
      }
    });

    //  Get Top Winners ranked by the number of contests won
    app.get("/top-winners-ranking", async (req, res) => {
      try {
        const ranking = await contestsCollection
          .aggregate([
            {
              $match: {
                winner: { $exists: true, $ne: null },
              },
            },
            {
              // Group by winner.email
              $group: {
                _id: "$winner.email",
                totalWins: { $sum: 1 },
                winnerName: { $first: "$winner.name" },
                winnerPhoto: { $first: "$winner.photo" },
              },
            },
            {
              $sort: { totalWins: -1 },
            },
            {
              $project: {
                _id: 0,
                email: "$_id",
                name: "$winnerName",
                photo: "$winnerPhoto",
                wins: "$totalWins",
              },
            },
          ])
          .toArray();

        res.send(ranking);
      } catch (err) {
        console.error("Error fetching top winners ranking:", err);
        res.status(500).send({ error: "Failed to fetch top winners ranking" });
      }
    });

    // Get all contests where the current user is declared the winner
    app.get("/my-winning-contests", verifyJWT, async (req, res) => {
      try {
        const winnerEmail = req.tokenEmail;

        const winningContests = await contestsCollection
          .find({
            status: "Completed",
            "winner.email": winnerEmail,
          })
          .project({
            _id: 1,
            name: 1,
            category: 1,
            prizeMoney: 1,
            image: 1,
            winner: 1,
          })
          .sort({ "winner.declaredAt": -1 })
          .toArray();

        res.send(winningContests);
      } catch (err) {
        console.error("Error fetching winning contests:", err);
        res.status(500).send({ error: "Failed to fetch winning contests" });
      }
    });

    // --- NEW API ROUTE: Get Participant Stats and Profile ---
    app.get("/my-stats", verifyJWT, async (req, res) => {
      try {
        const email = req.tokenEmail;

        // 1. Get Participation Count (from ordersCollection)
        const participationCount = await ordersCollection.countDocuments({
          participant: email,
        });

        // 2. Get Win Count (from contestsCollection)
        const winCount = await contestsCollection.countDocuments({
          "winner.email": email,
          status: "Completed",
        });

        // 3. Get User Profile Data
        const userProfile = await usersCollection.findOne(
          { email },
          {
            projection: {
              _id: 0,
              name: 1,
              email: 1,
              photo: 1,
              role: 1,
              bio: 1,
            },
          }
        );

        // Calculate Win Percentage
        let winPercentage = 0;
        if (participationCount > 0) {
          winPercentage = (winCount / participationCount) * 100;
        }

        res.send({
          participationCount,
          winCount,
          winPercentage: winPercentage.toFixed(2), // 2 decimal places
          profile: userProfile,
        });
      } catch (err) {
        console.error("Error fetching user stats:", err);
        res.status(500).send({ error: "Failed to fetch user stats" });
      }
    });

    // user-profile-update`
    app.patch("/user-profile-update", verifyJWT, async (req, res) => {
      try {
        const email = req.tokenEmail;
        const { name, photo, bio } = req.body;

        const updateDoc = {
          $set: {
            name: name,
            photo: photo,
            bio: bio,
            lastUpdated: new Date(),
          },
        };

        const result = await usersCollection.updateOne({ email }, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "User not found." });
        }

        res.send({ message: "Profile updated successfully!", result });
      } catch (err) {
        console.error("Error updating user profile:", err);
        res.status(500).send({ error: "Failed to update profile" });
      }
    });

    // --save or updata user--
    app.post("/user", async (req, res) => {
      const userData = req.body;

      userData.created_at = new Date().toISOString();
      userData.lastLoggedIn = new Date().toISOString();
      userData.role = "participant";
      const query = {
        email: userData.email,
      };
      const alreadyExists = await usersCollection.findOne(query);
      if (alreadyExists) {
        const result = await usersCollection.updateOne(query, {
          $set: { lastLoggedIn: new Date().toISOString() },
        });
        return res.send(result);
      }

      const result = await usersCollection.insertOne(userData);
      res.send(result);
    });

    // get an users role--
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // save become creator--
    app.post("/become-creator", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const alreadyExists = await creatorRequestsCollection.findOne({ email });
      if (alreadyExists) {
        return res
          .status(409)
          .send({ message: "Already requested to being Contest Creator" });
      }
      const result = await creatorRequestsCollection.insertOne({ email });
      res.send(result);
    });

    // get all creator request to admin
    app.get("/creator-requests", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await creatorRequestsCollection.find().toArray();
      res.send(result);
    });

    // get all users for admin
    app.get("/users", verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });

    // ---update role (admin)
    app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } }
      );
      await creatorRequestsCollection.deleteOne({ email });

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

// Root route
app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
