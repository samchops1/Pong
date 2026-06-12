import { Router } from "express";

const router = Router();

router.post("/commentary", async (req, res) => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];

  if (!apiKey) {
    res.json({ text: null });
    return;
  }

  try {
    const body = req.body as Record<string, unknown>;
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 60,
        system:
          "You are an over-the-top, hilarious sports commentator for a beer pong game. Respond with ONE short punchy line of commentary, max 20 words, no preamble, no quotes.",
        messages: [
          { role: "user", content: JSON.stringify(body) },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[commentary] Anthropic API error ${response.status}: ${errBody}`);
      res.json({ text: null });
      return;
    }

    const data = (await response.json()) as {
      content?: Array<{ text: string }>;
    };
    const text = data.content?.[0]?.text ?? null;
    if (!text) {
      console.error("[commentary] Anthropic returned no text content", data);
    }
    res.json({ text });
  } catch (err) {
    console.error("[commentary] Unexpected error calling Anthropic:", err);
    res.json({ text: null });
  }
});

export default router;
