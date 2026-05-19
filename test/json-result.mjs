function findFirstJsonValue(text) {
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") continue;

    const stack = [opener];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char);
        continue;
      }
      if (char !== "}" && char !== "]") continue;

      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) break;
      stack.pop();
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

export function extractJsonResult(rawResult) {
  const trimmed = String(rawResult ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return JSON.parse(fenced[1].trim());

  try {
    return JSON.parse(trimmed);
  } catch (strictError) {
    const value = findFirstJsonValue(trimmed);
    if (value) return JSON.parse(value);
    throw strictError;
  }
}
