import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import type { AgentMessage, JsonObject } from '../src/pi/protocol';
import type { ToolView, ViewState } from '../src/shared/bridge';
const md = new MarkdownIt({html:false,linkify:true,breaks:true});
const original = md.validateLink.bind(md); md.validateLink = url => /^https?:/i.test(url) && original(url);
export function renderMarkdown(text: string): string { return DOMPurify.sanitize(md.render(text),{ALLOWED_URI_REGEXP:/^https?:\/\//i,FORBID_TAGS:['style','script','iframe','form','input'],FORBID_ATTR:['style']}); }
export function shouldSend(event: {key:string;isComposing:boolean;shiftKey:boolean}): boolean { return event.key === 'Enter' && !event.isComposing && !event.shiftKey; }
export function element<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string,text?:string): HTMLElementTagNameMap[K] { const node = document.createElement(tag); if(className) node.className = className; if(text !== undefined) node.textContent = text; return node; }
export function renderChat(container: HTMLElement,state: ViewState) {
 const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
 const opened = new Set([...container.querySelectorAll<HTMLDetailsElement>('details[open][data-key]')].map(node => node.dataset.key));
 const fragment = document.createDocumentFragment(); const shown = new Set<string>();
 for (const [index,message] of state.messages.entries()) {
   if (message.role === 'toolResult') continue;
   const node = element('article',message.role === 'user' ? 'user-message':'assistant-message');
   renderContent(node,message,index,state.tools,shown); fragment.append(node);
   if (message.errorMessage) node.append(element('pre','error',message.errorMessage));
 }
 for(const tool of state.tools) if(!shown.has(tool.id)) fragment.append(renderTool(tool));
 if (!state.messages.length) { const empty = element('div','empty'); empty.append(element('div','pi-mark','π'),element('h1','','在这里，继续你的工作。'),element('p','','本机 PI 的模型、工具与技能，直接在编辑器中使用。')); fragment.append(empty); }
 container.replaceChildren(fragment);
 for(const node of container.querySelectorAll<HTMLDetailsElement>('details[data-key]')) if(opened.has(node.dataset.key)) node.open = true;
 if(nearBottom) container.scrollTop = container.scrollHeight;
}
function renderContent(node:HTMLElement,message:AgentMessage,index:number,tools:ToolView[],shown:Set<string>) {
 if(typeof message.content === 'string') { appendText(node,message.content); return; }
 for(const [blockIndex,block] of message.content.entries()) {
   if(!block) continue;
   if(block.type === 'text') appendText(node,block.text ?? '');
   else if(block.type === 'thinking') { const details = element('details','thinking'); details.dataset.key = `thinking-${index}-${blockIndex}`; details.append(element('summary','','思考'),element('div','thinking-text',block.thinking ?? '')); node.append(details); }
   else if(block.type === 'image') appendImage(node,block);
   else if(block.type === 'toolCall') { const tool = tools.find(tool => tool.id === block.id); if(tool) { shown.add(tool.id); node.append(renderTool(tool)); } }
 }
}
function appendText(node:HTMLElement,text:string) { const body = element('div','markdown'); body.innerHTML = renderMarkdown(text); node.append(body); }
function appendImage(node:HTMLElement,block:JsonObject) { if(typeof block.data !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType ?? '') || !/^[A-Za-z0-9+/=\s]+$/.test(block.data)) return; const image = element('img','content-image'); image.alt = 'PI 图片'; image.src = `data:${block.mimeType};base64,${block.data}`; node.append(image); }
export function renderTool(tool:ToolView) {
 const details = element('details',`tool ${tool.status}`); details.dataset.key = `tool-${tool.id}`;
 const marker = tool.status === 'pending' ? '·' : tool.status === 'success' ? '✓':'×';
 const label = `${marker} ${tool.name}  ${String(tool.args.path ?? tool.args.command ?? '').slice(0,140)}`;
 details.append(element('summary','',label),element('pre','tool-args',JSON.stringify(tool.args,null,2)));
 for(const block of tool.result?.content ?? []) {
  if(block.type === 'text') { const text = String(block.text ?? ''); details.append(element('pre','tool-output',text.slice(0,30000) + (text.length > 30000 ? '\n…显示已截断（插件限制）':''))); }
  else if(block.type === 'image') appendImage(details,block);
 }
 if(tool.name === 'edit' && tool.status !== 'pending' && tool.result?.details) {
  const patch = tool.result.details.diff ?? tool.result.details.patch;
  if(typeof patch === 'string') { details.append(element('div','muted','已修改 · 差异'),element('pre','diff',patch.slice(0,30000))); }
 }
 if(tool.durationMs !== undefined) details.append(element('small','muted',`${tool.durationMs} ms`));
 return details;
}
