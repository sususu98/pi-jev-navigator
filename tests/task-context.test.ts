import {describe,it,expect} from 'bun:test';
import {boundTaskContext,collectTaskContext,contextualRoutingTask} from '../src/memory/task-context.ts';

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
  it('bounds the newest context and keeps current request authoritative',()=>{
    const context=boundTaskContext(Array.from({length:20},(_,i)=>({role:'user' as const,text:`task${i} ${'x'.repeat(10000)}`})));
    expect(context).toHaveLength(4);
    expect(context[0].text).toContain('task16');
    expect(context.every(message=>message.text.length<=1200)).toBe(true);
    const task=contextualRoutingTask('Switch to documentation only',context);
    expect(task).toContain('explicit new topic overrides');
    expect(task).toContain('Switch to documentation only');
    expect(contextualRoutingTask('standalone task',[])).toBe('standalone task');
  });
});
