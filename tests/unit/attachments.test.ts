import { expect, it } from 'vitest';
import { AttachmentService } from '../../src/features/attachments';
import { SessionStore } from '../../src/state/session-store';
it('uses current unsaved selection content and line boundaries, and only sends referenced attachments', async () => {
 const store=new SessionStore();const service=new AttachmentService(store);
 const attachment=await service.fromSelection({document:{fileName:'中文.ts',uri:{scheme:'untitled'},getText:()=> '未保存文本'},selection:{start:{line:1},end:{line:3}}} as any);
 const payload=await service.buildPayload([attachment.id]);expect(payload.text).toContain('未保存文本');expect(payload.text).toContain('2-4');
 service.remove(attachment.id);expect((await service.buildPayload([])).text).toBe('');await expect(service.buildPayload([attachment.id])).rejects.toThrow(/attachment/i);
});
it('rejects mismatched images and text-only models, then permits a supported model',async()=>{
 const store=new SessionStore();const service=new AttachmentService(store);
 await expect(service.addImage({bytes:Buffer.from('not image'),mimeType:'image/png',name:'bad'})).rejects.toThrow(/image/i);
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
 const image=await service.addImage({bytes,mimeType:'image/png',name:'one.png'});
 await expect(service.buildPayload([image.id])).rejects.toThrow(/model/i);store.update({model:{id:'vision',provider:'test',input:['image','text']}});
 expect((await service.buildPayload([image.id])).images[0].data).toBe(bytes.toString('base64'));
 store.update({model:{id:'text',provider:'test',input:['text']}});await expect(service.buildPayload([image.id])).rejects.toThrow(/model/i);service.remove(image.id);expect(store.getSnapshot().attachments).toEqual([]);
});
