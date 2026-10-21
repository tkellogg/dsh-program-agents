import{createElement as h,useEffect,useState}from'react';
import type{ModelSelection,ModelSlotView}from'../models.js';
import type{ProgramClient,ProgramModelConfiguration}from'./transport.js';
const control={font:'inherit',color:'inherit',background:'var(--dsw-specific-menu, Canvas)',border:'1px solid #8885',borderRadius:5,padding:'3px 6px',maxWidth:'100%'};
const routeKey=(route:ModelSelection)=>JSON.stringify([route.provider,route.model]);
function Slot({slot,config,client,program,onSaved}:{slot:ModelSlotView;config:ProgramModelConfiguration;client:ProgramClient;program:string;onSaved:()=>void}){
 const[selected,setSelected]=useState(slot.selection),[pending,setPending]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setSelected(slot.selection);setError('');},[slot.revision]);
 const model=config.catalog.groups.find(g=>g.id===selected.provider)?.models.find(m=>m.id===selected.model),unavailable=!model;
 const save=async(reset=false)=>{setPending(true);setError('');try{await client.setModel!(program,slot.id,reset?null:selected,slot.revision,new AbortController().signal);onSaved();}catch(e){setError(e instanceof Error?e.message:'Model change failed');}finally{setPending(false);}};
 return h('fieldset',{style:{border:'1px solid #8884',borderRadius:6,margin:'6px 0',padding:8},disabled:pending},
  h('legend',null,slot.id),h('div',{style:{opacity:.8,marginBottom:5}},slot.description),
  h('div',{style:{display:'flex',flexWrap:'wrap',gap:6,alignItems:'center'}},
   h('label',null,'Model ',h('select',{'aria-label':`Model for ${slot.id}`,style:control,value:routeKey(selected),onChange:(event:any)=>{const[provider,model]=JSON.parse(event.target.value);setSelected({provider,model});}},
    unavailable?h('option',{value:routeKey(selected)},`${selected.provider} / ${selected.model} (unavailable)`):null,
    ...config.catalog.groups.map(group=>h('optgroup',{key:group.id,label:group.name},...group.models.map(item=>h('option',{key:item.id,value:routeKey({provider:group.id,model:item.id})},item.name))))),
   h('label',null,'Reasoning ',h('select',{'aria-label':`Reasoning for ${slot.id}`,style:control,value:selected.reasoningEffort??'',onChange:(event:any)=>setSelected(({provider,model})=>({provider,model,...event.target.value?{reasoningEffort:event.target.value}:{}}))},h('option',{value:''},'Model default'),
    ...(selected.reasoningEffort&&!model?.reasoning?.efforts.some(e=>e.id===selected.reasoningEffort)?[h('option',{key:'unavailable',value:selected.reasoningEffort},selected.reasoningEffort+' (unavailable)')]:[]),
    ...(model?.reasoning?.efforts??[]).map(e=>h('option',{key:e.id,value:e.id},e.name))))),
   h('button',{type:'button',style:control,onClick:()=>void save(),disabled:pending||unavailable},pending?'Saving…':'Save'),
   h('button',{type:'button',style:control,onClick:()=>void save(true),disabled:pending||!slot.overridden},'Use program default')),
  h('div',{style:{opacity:.65,fontSize:11,marginTop:5}},`Default: ${slot.default.provider} / ${slot.default.model}${slot.default.reasoningEffort?' / '+slot.default.reasoningEffort:''}${slot.overridden?' · User override':''}`),
  unavailable?h('p',{role:'status'},'Saved model is unavailable. It will not silently fall back.'):null,
  error?h('p',{role:'alert'},error):null);
}
export function ProgramModels({client,program,revision}:{client:ProgramClient;program:string;revision?:string}){
 const[config,setConfig]=useState<ProgramModelConfiguration>(),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 useEffect(()=>{const abort=new AbortController();setError('');void client.modelConfiguration!(program,abort.signal).then(value=>{if(!abort.signal.aborted)setConfig(value);},e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Model configuration unavailable');});return()=>abort.abort();},[client,program,revision,refresh]);
 return h('div',{'aria-label':'Program model configuration',style:{marginTop:6}},
  h('p',{style:{opacity:.75}},'Selections affect future model-slot calls and newly created conversations. Existing conversations retain their model.'),
  error?h('p',{role:'alert'},error):null,!config&&!error?h('p',null,'Loading models…'):null,
  ...(config?.slots??[]).map(slot=>h(Slot,{key:slot.id,slot,config:config!,client,program,onSaved:()=>setRefresh(n=>n+1)})),
  ...(config?.catalog.failures??[]).map(f=>h('p',{key:f.id,role:'status'},`${f.name}: ${f.message}`)));
}
