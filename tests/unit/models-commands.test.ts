import { expect, it, vi } from 'vitest';
import { ModelService } from '../../src/features/models';
import { CommandService } from '../../src/features/commands';
import { SessionStore } from '../../src/state/session-store';
it('refreshes thinking levels after model selection and preserves state if PI rejects',async()=>{
 const store=new SessionStore();const request=vi.fn(async(cmd:any)=>cmd.type==='set_model'?{id:'new',provider:'test',input:['text']}:cmd.type==='get_available_thinking_levels'?{levels:['off','low']}:{models:[]});
 const service=new ModelService({request} as any,store);await service.select('test','new');expect(store.getSnapshot().thinkingLevels).toEqual(['off','low']);
 request.mockRejectedValueOnce(new Error('no model'));await expect(service.select('test','bad')).rejects.toThrow();expect(store.getSnapshot().model?.id).toBe('new');
});
it('uses discovered command names verbatim and lets PI expand templates',async()=>{
 const request=vi.fn(async(cmd:any)=>cmd.type==='get_commands'?{commands:[{name:'skill:review',source:'skill'},{name:'explain',source:'prompt'},{name:'ext',source:'extension'}]}:{disposition:'handled'});
 const store=new SessionStore();const service=new CommandService({request} as any,store);await service.refresh();await service.invoke('skill:review','file.ts');
 expect(request).toHaveBeenLastCalledWith({type:'prompt',message:'/skill:review file.ts',streamingBehavior:'followUp'},{timeoutMs:0});
 await expect(service.invoke('settings','')).rejects.toThrow(/discover/i);expect(store.getSnapshot().run).toBe('idle');
});
