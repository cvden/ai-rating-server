
import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { Pool } from "pg";

dotenv.config();

const app = express();
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS catalog_items (
      asset_id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER,
      item_type TEXT,
      category TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("Catalog database table is ready.");
}

app.use(express.json({ limit: "1mb" }));

// Simple per-user cooldown
const cooldowns = new Map();
const COOLDOWN_MS = 10000;

app.get("/catalog-status", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT COUNT(*)::int AS item_count FROM catalog_items"
    );

    res.json({
      connected: true,
      itemCount: result.rows[0].item_count,
    });
  } catch (error) {
    console.error("Catalog database check failed:", error.message);

    res.status(500).json({
      connected: false,
      error: "Database check failed.",
    });
  }
});

app.post("/rate", async (req, res) => {
  const userId = String(req.body?.userId ?? "");

  if (!/^\d{1,20}$/.test(userId)) {
    return res.status(400).json({ error: "Invalid or missing userId" });
  }

  const now = Date.now();
  const last = cooldowns.get(userId) || 0;

  if (now - last < COOLDOWN_MS) {
    const remaining = Math.ceil(
      (COOLDOWN_MS - (now - last)) / 1000
    );
    return res.status(429).json({
      error: `Please wait ${remaining}s before requesting again.`,
    });
  }

  cooldowns.set(userId, now);

  try {
    // Get the Roblox avatar thumbnail
    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=720x720&format=Png`
    );

    if (!thumbRes.ok) {
      throw new Error("Roblox thumbnail service failed.");
    }

    const thumbJson = await thumbRes.json();
    const avatarUrl = thumbJson?.data?.[0]?.imageUrl;

    if (!avatarUrl) {
      return res.status(400).json({
        error: "Failed to get avatar thumbnail.",
      });
    }

    // Download the image for Gemini
    const imageRes = await fetch(avatarUrl);

    if (!imageRes.ok) {
      throw new Error("Could not download avatar image.");
    }

    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
    const base64Image = imageBuffer.toString("base64");
    const contentType =
      imageRes.headers.get("content-type")?.split(";")[0] ||
      "image/png";

    const result = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `You are a knowledgeable, honest Roblox avatar stylist.

Analyze only what is visible in the avatar image. Rate the overall outfit from 1 to 5 stars:
1 = poorly coordinated, 3 = average, 5 = exceptional.

Consider color coordination, clothing, accessories, visual balance,
cohesion, and originality. Be fair and specific; do not invent
items or claim to see details that are not visible.

Return exactly this JSON structure:
{
  "rating": 3,
  "comment": "One concise sentence, maximum 80 characters.",
  "pros": ["Short strength", "Short strength"],
  "cons": ["Short improvement", "Short improvement"]
}

Rules:
- rating must be an integer from 1 through 5.
- comment must be one sentence.
- Include exactly two pros and two cons.
- Keep each pro and con under 6 words.
- No markdown or emojis.`,
            },
            {
              inlineData: {
                mimeType: contentType,
                data: base64Image,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            rating: { type: "INTEGER" },
            comment: { type: "STRING" },
            pros: {
              type: "ARRAY",
              items: { type: "STRING" },
            },
            cons: {
              type: "ARRAY",
              items: { type: "STRING" },
            },
          },
          required: ["rating", "comment", "pros", "cons"],
        },
      },
    });

    const candidate = JSON.parse(result.text || "{}");

    const rating = Math.max(
      1,
      Math.min(
        5,
        Number.isFinite(Number(candidate.rating))
          ? Math.round(Number(candidate.rating))
          : 3
      )
    );

    const cleanArray = (arr, fallback) => {
      const cleaned = Array.isArray(arr)
        ? arr
            .filter((item) => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
        : [];

      return [
        cleaned[0] || fallback[0],
        cleaned[1] || fallback[1],
      ];
    };

    const comment =
      typeof candidate.comment === "string" &&
      candidate.comment.trim()
        ? candidate.comment.trim().replace(/[\r\n]+/g, " ").slice(0, 120)
        : "A promising look with room to improve.";

    res.json({
      rating,
      comment,
      pros: cleanArray(candidate.pros, [
        "Cohesive overall look",
        "Interesting style choices",
      ]),
      cons: cleanArray(candidate.cons, [
        "Could use more detail",
        "Try stronger color contrast",
      ]),
    });
  } catch (err) {
    console.error("Gemini rating failed:", err.message);

    res.status(500).json({
      error: "Avatar rating temporarily unavailable.",
      rating: 3,
      comment: "We couldn't rate this avatar. Please try again.",
      pros: ["Ready for another try", "Your avatar is saved"],
      cons: ["Rating service unavailable", "Please try again later"],
    });
  }
});



app.post("/catalog-collect", async (req, res) => {
  // Protect the collector so strangers cannot trigger catalog scans.
  const adminKey = process.env.CATALOG_ADMIN_KEY;

  if (!adminKey || req.get("x-admin-key") !== adminKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const requestedPages = Number(req.body?.pages ?? 1);
  const pages = Number.isInteger(requestedPages)
    ? Math.max(1, Math.min(requestedPages, 5))
    : 1;

  let cursor = req.body?.cursor || null;
  let pagesFetched = 0;
  let itemsSaved = 0;

  try {
    for (let page = 0; page < pages; page++) {
      const url = new URL(
        "https://catalog.roblox.com/v1/search/items/details"
      );

      url.searchParams.set("Category", "11");
      url.searchParams.set("Limit", "30");
      url.searchParams.set("SortType", "0");
      url.searchParams.set("SortAggregation", "5");

      if (cursor) {
        url.searchParams.set("Cursor", cursor);
      }

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Roblox returned HTTP ${response.status}`);
      }

      const result = await response.json();
      const items = Array.isArray(result.data) ? result.data : [];

      for (const item of items) {
        const id = String(item.id ?? "");
        const name = item.name;

        if (!/^\d+$/.test(id) || typeof name !== "string" || !name.trim()) {
          continue;
        }

        const rawPrice = item.price;
        const price =
          Number.isInteger(rawPrice) && rawPrice >= 0
            ? rawPrice
            : null;

        await db.query(
          `INSERT INTO catalog_items
             (asset_id, name, price, item_type, category, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (asset_id) DO UPDATE SET
             name = EXCLUDED.name,
             price = EXCLUDED.price,
             item_type = EXCLUDED.item_type,
             category = EXCLUDED.category,
             updated_at = NOW()`,
          [id, name.trim(), price, item.itemType ?? null, "11"]
        );

        itemsSaved++;
      }

      pagesFetched++;
      cursor = result.nextPageCursor || null;

      if (!cursor || items.length === 0) {
        break;
      }
    }

    const countResult = await db.query(
      "SELECT COUNT(*)::int AS item_count FROM catalog_items"
    );

    res.json({
      success: true,
      pagesFetched,
      itemsProcessed: itemsSaved,
      totalItemsInDatabase: countResult.rows[0].item_count,
      nextCursor: cursor,
      hasMore: Boolean(cursor),
    });
  } catch (error) {
    console.error("Catalog collection failed:", error.message);

    res.status(502).json({
      success: false,
      error: "Catalog collection failed. Check the Render logs.",
      pagesFetched,
      itemsProcessed: itemsSaved,
    });
  }
});

const PORT = process.env.PORT || 3000;

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Gemini Avatar Rater running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error.message);
    process.exit(1);
  });
