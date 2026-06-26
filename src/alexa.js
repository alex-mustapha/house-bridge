// Alexa custom-skill support: handles the "chores" skill's requests and maps the
// MarkDoneIntent to marking a chore done. Discord and Alexa speak different
// protocols, so this is its own handler.
//
// Verification here is personal-grade: it checks the skill's applicationId and
// the request timestamp. Full Amazon cert-chain signature verification (required
// only for public certification) is not implemented — fine for a private skill
// kept in the Development stage.

import { markChoreDone } from "./linear.js";

export function verifyAlexaRequest(body, env) {
  const appId =
    body?.context?.System?.application?.applicationId ||
    body?.session?.application?.applicationId;
  if (env.ALEXA_SKILL_ID && appId !== env.ALEXA_SKILL_ID) return false;

  const ts = body?.request?.timestamp;
  if (ts) {
    const t = Date.parse(ts);
    if (Number.isNaN(t) || Math.abs(Date.now() - t) > 150_000) return false;
  }
  return true;
}

function speak(text, endSession = true) {
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession: endSession,
    },
  };
}

export async function handleAlexa(body, env) {
  const req = body?.request || {};

  if (req.type === "LaunchRequest") {
    return speak("What did you finish? For example, say: I cleaned the bathroom.", false);
  }

  if (req.type === "IntentRequest") {
    const name = req.intent?.name;
    if (name === "MarkDoneIntent") {
      const chore = req.intent.slots?.chore?.value;
      if (!chore) return speak("I didn't catch which chore. Try: I cleaned the bathroom.", false);
      const result = await markChoreDone(env, chore);
      return speak(result.ok ? `Nice — I marked ${result.title} as done.` : result.message);
    }
    if (name === "AMAZON.HelpIntent") {
      return speak("Tell me a chore you finished, like: I cleaned the bathroom.", false);
    }
    if (name === "AMAZON.StopIntent" || name === "AMAZON.CancelIntent") {
      return speak("Okay.");
    }
    return speak("Sorry, I didn't understand. Try: I cleaned the bathroom.", false);
  }

  // SessionEndedRequest or anything else.
  return speak("", true);
}
