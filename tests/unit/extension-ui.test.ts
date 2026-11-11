import { expect, it, vi } from 'vitest';
import { ExtensionUiManager } from '../../src/features/extension-ui';
import { SessionStore } from '../../src/state/session-store';
it('answers each dialog at most once and ignores a late reply after timeout', async () => {
 const send = vi.fn(async () => {}); const manager = new ExtensionUiManager(new SessionStore(),send);
 manager.handle({type:'extension_ui_request',id:'a',method:'confirm',title:'Confirm'});
 await Promise.all([manager.reply('a',{confirmed:true}),manager.reply('a',{confirmed:false})]); expect(send).toHaveBeenCalledTimes(1);
 manager.handle({type:'extension_ui_request',id:'b',method:'input',title:'Input',timeout:5});
 await new Promise(resolve => setTimeout(resolve,15)); await manager.reply('b',{value:'late'}); expect(send).toHaveBeenCalledTimes(1);
 manager.dispose();
});
it('treats widgets as text, clears statuses and does not answer notifications', () => {
 const store = new SessionStore(); const send = vi.fn(async () => {}); const manager = new ExtensionUiManager(store,send);
 manager.handle({type:'extension_ui_request',id:'w',method:'setWidget',widgetKey:'one',widgetLines:['hello'],widgetPlacement:'belowEditor'});
 expect(store.getSnapshot().widgets.one.lines).toEqual(['hello']);
 manager.handle({type:'extension_ui_request',id:'s',method:'setStatus',statusKey:'one',statusText:'working'});
 manager.handle({type:'extension_ui_request',id:'s2',method:'setStatus',statusKey:'one'});
 expect(store.getSnapshot().statuses).toEqual({}); expect(send).not.toHaveBeenCalled(); manager.dispose();
});
