const KEY=process.env.PLINY_API_KEY, BASE="https://snps-inference.internal.synopsys.com/api/llm";
const [model,mode]=process.argv.slice(2);
const body={model,messages:[{role:"user",content:"A bat and ball cost $1.10. Bat costs $1 more than ball. Ball price? Think it through."}],max_tokens:2000,stream:false};
if(mode==="anthropic")body.thinking={type:"enabled",budget_tokens:1024};
if(mode==="effort")body.reasoning_effort="high";
(async()=>{const r=await fetch(BASE+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+KEY,"Content-Type":"application/json"},body:JSON.stringify(body)});
const j=await r.json();
if(j.error){console.log(model,mode,"ERR",JSON.stringify(j.error).slice(0,180));return;}
const m=j.choices[0].message;
console.log(`${model} [${mode}] reasoning_field=${!!(m.reasoning_content||m.reasoning)} rt=${j.usage?.completion_tokens_details?.reasoning_tokens??'n/a'} content="${(m.content||'').slice(0,60).replace(/\n/g,' ')}"`);
})();
