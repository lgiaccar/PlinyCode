const KEY=process.env.PLINY_API_KEY;
const BASE="https://snps-inference.internal.synopsys.com/api/llm";
const model=process.argv[2];
const body={model, messages:[{role:"user",content:"Read the file src/main.ts and tell me what it does. Use your tools."}],
 tools:[{type:"function",function:{name:"read_file",description:"Read a file from disk",
  parameters:{type:"object",properties:{path:{type:"string",description:"file path"}},required:["path"]}}}],
 tool_choice:"auto", stream:false, max_tokens:300};
(async()=>{
 const t=Date.now();
 const r=await fetch(BASE+"/chat/completions",{method:"POST",
   headers:{Authorization:"Bearer "+KEY,"Content-Type":"application/json"},body:JSON.stringify(body)});
 const txt=await r.text();
 let j; try{j=JSON.parse(txt)}catch(e){console.log(model,"HTTP",r.status,"NONJSON",txt.slice(0,200));return;}
 if(j.error){console.log(model,"HTTP",r.status,"ERR:",JSON.stringify(j.error).slice(0,300));return;}
 const m=j.choices?.[0]?.message||{};
 console.log(`${model} | HTTP ${r.status} | ${Date.now()-t}ms | tool_calls=${JSON.stringify(m.tool_calls||null).slice(0,220)} | finish=${j.choices?.[0]?.finish_reason}`);
})();
