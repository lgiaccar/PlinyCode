const KEY=process.env.PLINY_API_KEY, BASE="https://snps-inference.internal.synopsys.com/api/llm";
const model=process.argv[2];
const big="You are a coding agent. Here is the repo context:\n"+Array.from({length:900},(_,i)=>`// file${i}.ts: export const v${i} = ${i}; // some padding text to build a long stable prefix for caching purposes`).join("\n");
async function go(tag,useCacheCtl){
 const sys=useCacheCtl?[{type:"text",text:big,cache_control:{type:"ephemeral"}}]:big;
 const r=await fetch(BASE+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+KEY,"Content-Type":"application/json"},
  body:JSON.stringify({model,messages:[{role:"system",content:sys},{role:"user",content:"Say OK."}],max_tokens:10,stream:false})});
 const j=await r.json();
 if(j.error){console.log(model,tag,"ERR",JSON.stringify(j.error).slice(0,160));return;}
 console.log(`${model} ${tag} usage=${JSON.stringify(j.usage)}`);
}
(async()=>{await go("call1",process.argv[3]==="ctl");await go("call2",process.argv[3]==="ctl");})();
