import "./register-components";

export type { default as FormButton } from "@awesome.me/webawesome/dist/components/button/button.js";
export type { default as FormInput } from "@awesome.me/webawesome/dist/components/input/input.js";
export type { default as FormSelect } from "@awesome.me/webawesome/dist/components/select/select.js";
export type { default as FormSwitch } from "@awesome.me/webawesome/dist/components/switch/switch.js";
export type { default as FormTextarea } from "@awesome.me/webawesome/dist/components/textarea/textarea.js";

export function formButton(
  text: string,
  className = "",
): HTMLElementTagNameMap["wa-button"] {
  const button = document.createElement("wa-button");
  button.size = "s";
  button.appearance = "plain";
  button.variant = "neutral";
  button.textContent = text;
  button.className = className;
  return button;
}
