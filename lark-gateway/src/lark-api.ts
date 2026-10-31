import { Readable } from 'node:stream';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { LarkOps } from './inbound.js';
import { normalizeMessage } from './normalize.js';

type LarkClient = Client & Record<string, any>;
function check(response: any): any { if (response && typeof response.code === 'number' && response.code !== 0) throw new Error(`Lark API ${response.code}: ${response.msg || 'request failed'}`); return response?.data || response; }
async function streamBuffer(stream: Readable): Promise<Buffer> { const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part)); return Buffer.concat(parts); }

export class LarkApi implements LarkOps {
  constructor(private client: LarkClient) {}
  async download(messageId: string, key: string, type: string): Promise<{ name: string; contentType: string; bytes: Buffer }> {
    const resource = await this.client.im.messageResource.get({ path: { message_id: messageId, file_key: key }, params: { type } });
    return { name: key, contentType: resource.headers?.['content-type'] || 'application/octet-stream', bytes: await streamBuffer(resource.getReadableStream()) };
  }
  async parentText(messageId: string): Promise<string | null> {
    const response = check(await this.client.im.message.get({ path: { message_id: messageId } }));
    const message = response.items?.[0] || response.message || response;
    const content = message.body?.content || '';
    try { return normalizeMessage(message.msg_type || 'text', content).text || content || null; } catch { return content || null; }
  }
  async forwardedMessages(messageId: string): Promise<Array<{ content: string; sender?: { sender_name?: string } }>> {
    const response = check(await this.client.im.message.get({ path: { message_id: messageId } }));
    return (response.items || []).map((item: any) => ({ content: item.body?.content || '', sender: { sender_name: item.sender?.sender_name } }));
  }
  async reply(chatId: string, text: string, parentId?: string): Promise<void> {
    const data = { msg_type: 'text', content: JSON.stringify({ text }) };
    if (parentId) check(await this.client.im.message.reply({ path: { message_id: parentId }, data: { ...data, reply_in_thread: true } }));
    else check(await this.client.im.message.create({ params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : 'chat_id' }, data: { ...data, receive_id: chatId } }));
  }
  async react(messageId: string, emoji: string): Promise<void> {
    check(await this.client.im.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } }));
  }
  async finishReaction(messageId: string): Promise<void> {
    try {
      const list = await this.client.im.messageReaction.listWithIterator({ path: { message_id: messageId }, params: { page_size: 50 } });
      for await (const page of list as AsyncIterable<any>) for (const item of page?.items || []) if (item.reaction_type?.emoji_type === 'THUMBSUP' && item.operator?.operator_type === 'app') await this.client.im.messageReaction.delete({ path: { message_id: messageId, reaction_id: item.reaction_id } });
    } catch { /* reaction cleanup should not suppress a reply */ }
    await this.react(messageId, 'DONE');
  }
  async sendCard(chatId: string, card: Record<string, unknown>, parentId?: string, uuid?: string): Promise<string> {
    const data = { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true, uuid };
    const result = parentId ? check(await this.client.im.message.reply({ path: { message_id: parentId }, data })) : check(await this.client.im.message.create({ params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : 'chat_id' }, data: { ...data, receive_id: chatId } }));
    return result.message_id || result.message?.message_id || '';
  }
  async sendText(chatId: string, text: string, parentId?: string, uuid?: string): Promise<string> {
    const data = { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: true, uuid };
    const result = parentId ? check(await this.client.im.message.reply({ path: { message_id: parentId }, data })) : check(await this.client.im.message.create({ params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : 'chat_id' }, data: { ...data, receive_id: chatId } }));
    return result.message_id || result.message?.message_id || '';
  }
  async sendAttachment(chatId: string, parentId: string | undefined, attachment: any, uuid?: string): Promise<void> {
    const bytes = Buffer.from(attachment.content || '', 'base64');
    if (bytes.length > 25 * 1024 * 1024) throw new Error(`Attachment ${attachment.name || 'file'} exceeds 25 MB`);
    const image = String(attachment.content_type || '').startsWith('image/');
    let content: Record<string, string>;
    let msgType: string;
    if (image) {
      const uploaded = check(await this.client.im.image.create({ data: { image_type: 'message', image: bytes } }));
      content = { image_key: uploaded.image_key }; msgType = 'image';
    } else {
      const fileType = String(attachment.name || 'file').split('.').pop()?.toLowerCase();
      const valid = (['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt'].includes(fileType || '') ? fileType : 'stream') as 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
      const uploaded = check(await this.client.im.file.create({ data: { file_type: valid, file_name: attachment.name || 'attachment', file: bytes } }));
      content = { file_key: uploaded.file_key }; msgType = 'file';
    }
    const data = { msg_type: msgType, content: JSON.stringify(content), reply_in_thread: true, uuid };
    if (parentId) check(await this.client.im.message.reply({ path: { message_id: parentId }, data }));
    else check(await this.client.im.message.create({ params: { receive_id_type: chatId.startsWith('ou_') ? 'open_id' : 'chat_id' }, data: { ...data, receive_id: chatId } }));
  }
}

export { Readable };
