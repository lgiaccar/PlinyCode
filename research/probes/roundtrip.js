const KEY=process.env.PLINY_API_KEY, BASE="https://snps-inference.internal.synopsys.com/api/llm";
const model=process.argv[2];
const tools=[{type:"function",function:{name:"read_file",description:"Read a file",
 parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}}];
async function call(messages){
 const r=await fetch(BASE+"/chat/completions",{method:"POST",
  headers:{Authorization:"Bearer "+KEY,"Content-Type":"application/json"},
  body:JSON.stringify({model,messages,tools,stream:false,max_tokens:300})});
 const j=await r.json(); if(j.error)throw new Error(JSON.stringify(j.error));
 return j;}
(async()=>{
 const msgs=[{role:"user",content:"Read src/main.ts with your tool and summarize in one sentence."}];
 let j=await call(msgs); const m=j.choices[0].message;
 msgs.push(m);
 const tcs=m.tool_calls||[];
 for(const tc of tcs) msgs.push({role:"tool",tool_call_id:tc.id,content:"export function main(){ console.log('hello'); }"});
 j=await call(msgs);
 console.log(`${model} => turn2: "${(j.choices[0].message.content||"").slice(0,110).replace(/\n/g,' ')}" finish=${j.choices[0].finish_reason}`);
})().catch(e=>console.log(model,"FAIL",e.message.slice(0,200)));
