import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));

// Read ANTHROPIC_API_KEY from arch-ai/.env if that file exists (it is git-ignored).
try {
  process.loadEnvFile(path.join(here, ".env"));
} catch {}

const app = express();
const client = new Anthropic();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(here, "public")));
app.use("/vendor/three", express.static(path.join(here, "node_modules", "three")));

const FLOORS = ["wood", "tile", "concrete", "carpet", "stone"];

// The building model Claude returns. All lengths are in metres, plan coordinates
// have x pointing east and y pointing north, with the origin at the south-west corner.
const designSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "notes", "levels", "walls", "openings", "rooms", "roof"],
  properties: {
    name: { type: "string", description: "Short project name" },
    notes: { type: "string", description: "2-5 sentences for the architect: the design idea and anything they should check" },
    levels: {
      type: "array",
      description: "Storeys from the ground up. Index 0 is the ground floor.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "elevation", "height"],
        properties: {
          name: { type: "string" },
          elevation: { type: "number", description: "Finished floor level in metres above ground" },
          height: { type: "number", description: "Floor-to-floor height in metres, usually 2.8-3.2" },
        },
      },
    },
    walls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "level", "x1", "y1", "x2", "y2", "thickness", "height", "exterior"],
        properties: {
          id: { type: "string", description: "Unique, e.g. w1" },
          level: { type: "integer", description: "Index into levels" },
          x1: { type: "number" },
          y1: { type: "number" },
          x2: { type: "number" },
          y2: { type: "number" },
          thickness: { type: "number", description: "0.25-0.35 exterior, 0.10-0.15 interior" },
          height: { type: "number", description: "Wall height, normally the level height" },
          exterior: { type: "boolean" },
        },
      },
    },
    openings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "wallId", "type", "offset", "width", "height", "sill"],
        properties: {
          id: { type: "string", description: "Unique, e.g. d1 or win1" },
          wallId: { type: "string", description: "The wall this opening sits in" },
          type: { type: "string", enum: ["door", "window"] },
          offset: { type: "number", description: "Distance in metres from the wall's (x1,y1) end to the CENTRE of the opening" },
          width: { type: "number" },
          height: { type: "number" },
          sill: { type: "number", description: "Height of the bottom of the opening above the floor; 0 for doors, about 0.9 for windows" },
        },
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "level", "name", "x", "y", "width", "depth", "floor"],
        properties: {
          id: { type: "string" },
          level: { type: "integer" },
          name: { type: "string" },
          x: { type: "number", description: "South-west corner x" },
          y: { type: "number", description: "South-west corner y" },
          width: { type: "number", description: "Size along x" },
          depth: { type: "number", description: "Size along y" },
          floor: { type: "string", enum: FLOORS },
        },
      },
    },
    roof: {
      type: "object",
      additionalProperties: false,
      required: ["type", "pitch", "overhang"],
      properties: {
        type: { type: "string", enum: ["flat", "gable", "none"] },
        pitch: { type: "number", description: "Roof slope in degrees for gable roofs, e.g. 30" },
        overhang: { type: "number", description: "Eave overhang in metres, e.g. 0.4" },
      },
    },
  },
};

const SYSTEM = `You are an experienced residential architect. You produce a buildable concept design as a precise geometric model that an architect will refine in a 3D editor and export to AutoCAD.

Rules for the model:
- Units are metres. Plan x points east, y points north. Put the south-west corner of the building at (0,0) and keep every coordinate >= 0.
- Snap every coordinate to 0.05 m. Walls are straight segments measured on their centre line. Walls that meet must share the exact same endpoint so corners close. Keep walls orthogonal unless the brief asks otherwise.
- Exterior walls 0.30 m thick, interior walls 0.12 m. Wall height equals the level height.
- Rooms are axis-aligned rectangles measured between wall centre lines, and should tile the floor plate without overlapping. Use realistic sizes (bedroom >= 9 m², bathroom >= 4 m², corridors >= 1.1 m wide).
- Upper storeys sit on top of the ground floor footprint: reuse the same exterior wall lines on each level. If there is more than one storey, include a room named "Stairs" (about 1.0 x 3.0 m or larger) in the same position on every level.
- Every room must be reachable through doors. Interior doors 0.9 x 2.1 m, the entrance door 1.0 x 2.2 m. Bathrooms get a door; open-plan living/kitchen/dining can share one room or be divided by partial walls.
- Put windows only in exterior walls: about 1.2-2.4 m wide, 1.2-1.5 m high with a 0.9 m sill (bathrooms smaller and higher). Every habitable room needs at least one window.
- An opening's offset is measured from the wall's (x1,y1) end to the opening's centre. Keep each opening fully inside its wall with at least 0.15 m to the wall ends and never overlap two openings in the same wall.
- Give every wall, opening and room a unique id.

When you are given an existing design and a change request, return the complete updated design. Change only what the request needs and keep the ids of everything you did not change, so the architect's own edits are preserved.`;

app.post("/api/design", async (req, res) => {
  const brief = String(req.body?.brief ?? "").trim();
  const current = req.body?.design ?? null;
  if (brief.length < 5) {
    return res.status(400).json({ error: "Describe the building you want first (or the change you want)." });
  }

  const content = current
    ? `Here is the current design:\n<design>\n${JSON.stringify(current)}\n</design>\n\nChange request: ${brief}`
    : `Design brief: ${brief}`;

  try {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: designSchema } },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return res.status(422).json({ error: "The AI could not make this design. Try rewording the brief." });
    }
    if (message.stop_reason === "max_tokens") {
      return res.status(422).json({ error: "This building is too big for one request. Try a smaller brief." });
    }

    // If a fallback model took over mid-answer, only the text after the last switch is the real answer.
    const lastSwitch = message.content.findLastIndex((b) => b.type === "fallback");
    const text = message.content
      .slice(lastSwitch + 1)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    res.json({ design: JSON.parse(text) });
  } catch (err) {
    console.error(err);
    if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError)) {
      return res.status(500).json({ error: "No Anthropic API key is set up on the server. Set ANTHROPIC_API_KEY and restart it." });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: "The server's Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY and restart." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "Too many requests right now. Wait a minute and try again." });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(502).json({ error: "Could not reach the AI service. Check the internet connection." });
    }
    res.status(500).json({ error: "Something went wrong while making the design. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`Arch AI running at http://localhost:${PORT}`);
});
