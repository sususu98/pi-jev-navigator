import {describe,it,expect} from 'bun:test';
import {boundTaskContext,collectTaskContext,contextualRoutingTask,taskContextStats} from '../src/memory/task-context.ts';

describe('bounded branch-local routing context',()=>{
  it('ignores system, tools, thinking, custom tails and images',()=>{
    const entries=[
      {type:'message',message:{role:'system',content:'SYSTEM_SECRET'}},
      {type:'message',message:{role:'toolResult',content:'TOOL_SECRET'}},
      {type:'custom',message:{role:'user',content:'HISTORICAL_TAIL_SECRET'}},
      {type:'message',message:{role:'user',content:'Implement Orchid capsule'}},
      {type:'message',message:{role:'assistant',content:[{type:'thinking',text:'THINKING_SECRET'},{type:'image',data:'IMAGE_SECRET'},{type:'text',text:'Tenant isolation is required'}]}},
    ];
    const context=collectTaskContext(entries);
    expect(context).toEqual([{role:'user',text:'Implement Orchid capsule'},{role:'assistant',text:'Tenant isolation is required'}]);
    expect(JSON.stringify(context)).not.toContain('SECRET');
    expect(entries[0].message.content).toBe('SYSTEM_SECRET');
  });
  it('keeps each turn user request plus final assistant reply, not intermediate progress',()=>{
    const user=(content:string)=>({type:'message',message:{role:'user',content}});
    const assistant=(content:string)=>({type:'message',message:{role:'assistant',content:[{type:'text',text:content}]}});
    const tool={type:'message',message:{role:'toolResult',content:'TOOL_BODY'}};
    const entries=[
      user('Review PR 3141 Antigravity web search'),assistant('progress A1'),tool,assistant('final A1'),
      user('use gemini-3.8-flash'),assistant('progress B1'),tool,assistant('progress B2'),tool,assistant('final B'),
      user('use messages protocol'),assistant('final C'),
      user('try a real query'),assistant('progress D'),tool,assistant('final D'),
      user('now check the docs'),assistant('final E'),
    ];
    const context=collectTaskContext(entries);
    expect(context[0]).toEqual({role:'user',text:'Review PR 3141 Antigravity web search',anchor:true});
    expect(context.slice(1).map(message=>message.text)).toEqual([
      'use gemini-3.8-flash','final B','use messages protocol','final C','try a real query','final D','now check the docs','final E']);
    expect(JSON.stringify(context)).not.toMatch(/progress|TOOL_BODY/);
    expect(taskContextStats(context)).toEqual({turns:4,messages:9,chars:context.reduce((n,m)=>n+m.text.length,0),anchor:true});
    expect(collectTaskContext(entries.slice(0,4))).toEqual([{role:'user',text:'Review PR 3141 Antigravity web search'},{role:'assistant',text:'final A1'}]);
    expect(boundTaskContext(context)).toEqual(context); // idempotent across extractor/routing calls
  });
  it('bounds the newest context and keeps current request authoritative',()=>{
    const context=boundTaskContext(Array.from({length:20},(_,i)=>({role:'user' as const,text:`task${i} ${'x'.repeat(10000)}`})));
    expect(context).toHaveLength(5);
    expect(context[0].text).toContain('task15');
    expect(context.at(-1)!.text).toContain('task19');
    expect(context.every(message=>message.text.length<=1200)).toBe(true);
    expect(context.reduce((n,m)=>n+m.text.length,0)).toBeLessThanOrEqual(6000);
    const anchored=boundTaskContext([{role:'user',text:'ANCHOR '+'y'.repeat(5000),anchor:true},...context]);
    expect(anchored[0].anchor).toBe(true);
    expect(anchored.reduce((n,m)=>n+m.text.length,0)).toBeLessThanOrEqual(6000);
    expect(anchored.at(-1)!.text).toContain('task19');
    const task=contextualRoutingTask('Switch to documentation only',context);
    expect(task).toContain('explicit new topic overrides');
    expect(task).toContain('Switch to documentation only');
    expect(contextualRoutingTask('standalone task',[])).toBe('standalone task');
  });
});
