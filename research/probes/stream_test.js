const KEY=process.env.PLINY_API_KEY, BASE="https://snps-inference.internal.synopsys.com/api/llm";
const model=process.argv[2];
(async()=>{
const body={model,messages:[{role:"user",content:"Read src/main.ts using your tool, then say DONE."}],
 tools:[{type:"function",function:{name:"read_file",description:"Read a file",
  parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}}],
 stream:true,stream_options:{include_usage:true},max_tokens:200};
const t=Date.now();
const r=await fetch(BASE+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+KEY,"Content-Type":"application/json"},body:JSON.stringify(body)});
if(!r.ok){console.log(model,"HTTP",r.status,(await r.text()).slice(0,200));return;}
const rd=r.body.getReader(),dec=new TextDecoder();let buf="",chunks=0,ttft=0,txt="",tc=0,usage=null;
while(true){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
 const lines=buf.split("\n");buf=lines.pop();
 for(const L of lines){if(!L.startsWith("data: "))continue;const d=L.slice(6).trim();if(d==="[DONE]")continue;
  let j;try{j=JSON.parse(d)}catch(e){continue}
  if(!ttft)ttft=Date.now()-t; chunks++;
  if(j.usage)usage=j.usage;
  const dl=j.choices?.[0]?.delta;if(!dl)continue;
  if(dl.content)txt+=dl.content;
  if(dl.tool_calls)tc+=dl.tool_calls.length;}}
console.log(`${model} | ttft=${ttft}ms tot=${Date.now()-t}ms chunks=${chunks} toolDeltas=${tc} text="${txt.slice(0,40).replace(/\n/g,' ')}" usage=${JSON.stringify(usage)}`);
})();
