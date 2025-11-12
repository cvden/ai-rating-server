import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";

dotenv.config();
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());

// 🔒 Simple per-user cooldown system
const cooldowns = new Map();
const COOLDOWN_MS = 10000; // 10 seconds

app.post("/rate", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  // 🔒 Cooldown protection
  const now = Date.now();
  const last = cooldowns.get(userId) || 0;
  if (now - last < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
    return res
      .status(429)
      .json({ error: `Please wait ${remaining}s before requesting again.` });
  }
  cooldowns.set(userId, now);

  try {
    const thumbRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=720x720&format=Png`
    );
    const thumbJson = await thumbRes.json();
    const avatarUrl = thumbJson?.data?.[0]?.imageUrl;

    if (!avatarUrl) {
      return res.status(400).json({ error: "Failed to get avatar thumbnail." });
    }

    // ✅ 2. Ask OpenAI to analyze and rate the avatar
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are an energetic Roblox avatar stylist.
Rate this avatar 1–5 stars, be critical; 5 stars should be exceptional, 3 average, 1 poor. Give a short, fun, one-sentence comment (max 80 chars),
and list exactly two short pros and two short cons (each under 6 words).
Do NOT use markdown, emojis, or line breaks.

Respond ONLY with JSON in this format:
{
  "rating": number,
  "comment": "short comment",
  "pros": ["non-empty short text", "non-empty short text"],
  "cons": ["non-empty short text", "non-empty short text"]
}`,
            },
            { type: "image_url", image_url: { url: avatarUrl } },
          ],
        },
      ],
    });

    // ✅ 3. Clean up AI output
    let message = completion.choices[0].message.content.trim();
    message = message.replace(/```json|```/gi, "").trim();

    // ✅ 4. Fallback defaults (in case AI messes up)
    let parsed = {
      rating: 3,
      comment: "Nice outfit!",
      pros: ["Good color balance", "Fun accessories"],
      cons: ["Could use detail", "Average creativity"],
    };

    // ✅ 5. Attempt to parse JSON safely
    try {
      const candidate = JSON.parse(message);

      // helper to sanitize and filter arrays
      const cleanArray = (arr, fallback) => {
        if (!Array.isArray(arr)) return fallback;
        const filtered = arr
          .map((s) => String(s || "").trim())
          .filter((s) => s.length > 0);
        return filtered.length > 0 ? filtered.slice(0, 2) : fallback;
      };

      parsed.rating = Number(candidate.rating) || parsed.rating;
      parsed.comment =
        typeof candidate.comment === "string" && candidate.comment.trim().length > 0
          ? candidate.comment.trim()
          : parsed.comment;
      parsed.pros = cleanArray(candidate.pros, parsed.pros);
      parsed.cons = cleanArray(candidate.cons, parsed.cons);
    } catch (err) {
      console.warn("⚠️ Failed to parse AI response:", message);
    }

    // ✅ 6. Final sanitization
    const rating = Math.max(1, Math.min(5, Number(parsed.rating) || 3));
    const comment = String(parsed.comment || "Nice look!").replace(/[\r\n]+/g, " ");
    const pros = parsed.pros;
    const cons = parsed.cons;

    // ✅ 7. Send clean JSON back to Roblox
    res.json({
      rating,
      comment,
      pros,
      cons,
    });
  } catch (err) {
    console.error("AI rating failed:", err.response?.data || err.message);
    res.status(500).json({
      rating: 3,
      comment: "AI error — defaulted to 3★.",
      pros: ["Stylish base", "Clean outfit"],
      cons: ["Server timeout", "Try again later"],
    });
  }
});

// ✅ Start local webserver
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ AI Avatar Rater running on port ${PORT}`)
);