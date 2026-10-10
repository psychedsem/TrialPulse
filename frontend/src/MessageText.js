import { createElement } from "react";
import Markdown from "react-markdown";

export function MessageText({ role, text }) {
  if (role === "user") return createElement("span", { className: "message__text" }, text);
  return createElement("div", { className: "message__text message__text--markdown" },
    createElement(Markdown, { skipHtml: true, disallowedElements: ["img"] }, text));
}