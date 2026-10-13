# 📚 Class Notes AI

Put your phone or laptop on the desk, press record, and the teacher's lesson turns into a colorful study course you can revise from.

**What you get for every lesson:**

- 📖 **Pages:** one colorful page per topic, with bullet points, examples and a "Remember" box
- 🔤 **Words:** the new vocabulary with definitions
- 🃏 **Flashcards:** tap to flip, shuffle to test yourself
- ✅ **Quiz:** multiple-choice questions with explanations and a score
- 💡 **Tips:** memory tricks and what the teacher hinted would be on the test
- 🖨️ **Print / PDF:** print all the pages or save them as a PDF

Lessons are saved in your browser, so you can come back and revise any time.

## How it works

1. The browser listens to the teacher and writes down the words live, using the speech recognition built into Chrome, Edge and Safari.
2. When class ends, tap **✨ Make my course**. The transcript goes to Claude (Anthropic's AI), which cleans it up and organizes it into pages, flashcards and a quiz.
3. The course is shown in color and saved on your device.

If the page is closed by accident, the transcript so far is kept and comes back when you reopen it.

## Setup

You need [Node.js](https://nodejs.org) 20 or newer and an Anthropic API key from <https://console.anthropic.com>.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...     # Windows PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

Then open <http://localhost:3000> in **Chrome** or **Edge**.

## Using it in class

- **Easiest:** run it on your laptop and open `http://localhost:3000` on that laptop.
- **On your phone:** browsers only allow the microphone on secure (`https://`) sites. Put the app online on a host such as Render, Railway or Fly.io (set `ANTHROPIC_API_KEY` in the host's settings) and open the `https://` link on your phone.
- Sit near the front so the microphone hears the teacher clearly.
- Keep the screen on and the app open while recording. The app asks the phone to keep the screen awake.
- Pick the language the teacher speaks before you start. The course is written in that language.
- No microphone, or the browser doesn't support it? Type or paste the lesson into the text box and tap **Make my course**.
- Ask your teacher before recording a class.

## Files

| File | What it does |
|---|---|
| `server.js` | Small web server. Sends the transcript to Claude and returns the course. |
| `public/index.html` | The screens: home, record and course. |
| `public/app.js` | Live listening, saving lessons, and drawing the pages, flashcards and quiz. |
| `public/styles.css` | Colors and layout, with dark mode and print styles. |
