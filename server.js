import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(here, "public")));

const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];

// Shape of the course Claude returns. Every page is one section of the lesson.
const courseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "subject", "summary", "pages", "vocabulary", "flashcards", "quiz", "tips"],
  properties: {
    title: { type: "string" },
    subject: { type: "string" },
    summary: { type: "string", description: "3-4 sentence overview of the whole lesson" },
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "emoji", "color", "intro", "points", "keyIdea", "example"],
        properties: {
          heading: { type: "string" },
          emoji: { type: "string" },
          color: { type: "string", enum: COLORS },
          intro: { type: "string" },
          points: { type: "array", items: { type: "string" } },
          keyIdea: { type: "string", description: "The one thing to remember from this page" },
          example: { type: "string", description: "A concrete example, or empty string if none" },
        },
      },
    },
    vocabulary: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "definition"],
        properties: { term: { type: "string" }, definition: { type: "string" } },
      },
    },
    flashcards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["front", "back"],
        properties: { front: { type: "string" }, back: { type: "string" } },
      },
    },
    quiz: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "options", "answerIndex", "explanation"],
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          answerIndex: { type: "integer" },
          explanation: { type: "string" },
        },
      },
    },
    tips: {
      type: "array",
      description: "Memory tricks, mnemonics, and what is likely to be on the test",
      items: { type: "string" },
    },
  },
};

const SYSTEM = `You turn a raw classroom transcript into a clear, well-organised study course for a student.

The transcript comes from speech recognition, so expect missing punctuation, misheard words, repetitions, and off-topic classroom talk (attendance, jokes, "open your books"). Fix obvious mis-hearings from context, ignore the off-topic parts, and never invent facts the teacher did not say — if something is unclear, leave it out rather than guess. You may add a short clarifying explanation when it helps a student understand what the teacher said.

Write in the same language the teacher spoke. Keep sentences short and student-friendly.

Split the lesson into pages, one per topic, in the order the teacher covered them (usually 3-8 pages). Give each page a fitting emoji and a different color so the pages look varied. Points should be short bullet facts, not paragraphs; use **double asterisks** to bold the most important words.

Then add the vocabulary the teacher introduced, 6-12 flashcards, a 5-8 question multiple-choice quiz (4 options each, answerIndex is 0-based), and a few memory tips — including anything the teacher hinted would be on the test.`;

app.post("/api/course", async (req, res) => {
  const transcript = String(req.body?.transcript ?? "").trim();
  const subject = String(req.body?.subject ?? "").trim();
  if (transcript.split(/\s+/).length < 20) {
    return res.status(400).json({ error: "The transcript is too short. Record a bit more of the lesson first." });
  }

  try {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: courseSchema } },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `${subject ? `Subject: ${subject}\n\n` : ""}<transcript>\n${transcript}\n</transcript>`,
        },
      ],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return res.status(422).json({ error: "The AI could not process this transcript. Try again with a different recording." });
    }
    if (message.stop_reason === "max_tokens") {
      return res.status(422).json({ error: "This lesson is too long to turn into one course. Try splitting it into parts." });
    }

    // If a fallback model took over mid-answer, only the text after the last switch is the real answer.
    const lastSwitch = message.content.findLastIndex((b) => b.type === "fallback");
    const text = message.content
      .slice(lastSwitch + 1)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    res.json({ course: JSON.parse(text) });
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: "The server's Anthropic API key is missing or invalid." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Too many requests right now. Wait a minute and try again." });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(502).json({ error: "Could not reach the AI service. Check the internet connection." });
    }
    res.status(500).json({ error: "Something went wrong while making the course. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`Class Notes AI running at http://localhost:${PORT}`);
});
