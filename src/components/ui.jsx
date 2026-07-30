// ═══════════════════════════════════════════════════════════════════
// REUSABLE UI COMPONENTS — shared presentational primitives.
// Extracted verbatim from App.jsx; markup and styles unchanged.
// They depend only on the theme palette C.
// ═══════════════════════════════════════════════════════════════════
import { C } from "../lib/theme.js";

export const Card=({children,style={}})=><div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:20,...style}}>{children}</div>;
export const Btn=({children,onClick,variant="primary",size="md",disabled=false,style={}})=>{
  const variants={primary:{background:C.primary,color:"#fff",border:"none"},outline:{background:"transparent",color:C.primary,border:`1.5px solid ${C.primary}`},danger:{background:C.danger,color:"#fff",border:"none"},ghost:{background:"transparent",color:C.textMid,border:`1px solid ${C.border}`},accent:{background:C.accent,color:"#fff",border:"none"},zatca:{background:C.zatca,color:"#fff",border:"none"}};
  const sizes={sm:{padding:"5px 12px",fontSize:12},md:{padding:"8px 18px",fontSize:13},lg:{padding:"12px 28px",fontSize:15}};
  return<button onClick={onClick} disabled={disabled} style={{...variants[variant],...sizes[size],borderRadius:8,fontFamily:"inherit",fontWeight:600,cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.5:1,transition:"all 0.15s",...style}}>{children}</button>;
};
export const Inp=({label,value,onChange,type="text",placeholder="",style={},readOnly=false})=>(
  <div style={{display:"flex",flexDirection:"column",gap:4,...style}}>
    {label&&<label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>}
    <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} readOnly={readOnly} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:readOnly?C.bg:"#fff"}}/>
  </div>
);
export const Sel=({label,value,onChange,options,style={}})=>(
  <div style={{display:"flex",flexDirection:"column",gap:4,...style}}>
    {label&&<label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>}
    <select value={value} onChange={e=>onChange(e.target.value)} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff"}}>
      {options.map(o=><option key={o.value??o} value={o.value??o}>{o.label??o}</option>)}
    </select>
  </div>
);
// Multi-line text input — lets clients type onto the next line (Enter for newline)
export const TextArea=({label,value,onChange,placeholder="",rows=3,style={},dir})=>(
  <div style={{display:"flex",flexDirection:"column",gap:4,...style}}>
    {label&&<label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>}
    <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} dir={dir} style={{padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:8,fontSize:13,fontFamily:"inherit",color:C.text,background:"#fff",resize:"vertical",lineHeight:1.5}}/>
  </div>
);
// Slider — client picks any size in a range (e.g. font/QR/logo size)
export const Slider=({label,value,onChange,min,max,step=1,unit="px",style={}})=>(
  <div style={{display:"flex",flexDirection:"column",gap:6,...style}}>
    {label&&<div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>{label}</label>
      <span style={{fontSize:12,fontWeight:800,color:C.primary,background:C.primaryLight,borderRadius:6,padding:"2px 8px"}}>{value}{unit}</span>
    </div>}
    <input type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(parseInt(e.target.value))} style={{width:"100%",accentColor:C.primary,cursor:"pointer"}}/>
  </div>
);
// Toggle switch row
export const ToggleRow=({label,on,onClick})=>(
  <label style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
    <span style={{fontSize:12,color:C.text}}>{label}</span>
    <div onClick={onClick} style={{width:40,height:22,borderRadius:11,background:on?C.primary:"#CBD5E0",position:"relative",transition:"background 0.2s",cursor:"pointer",flexShrink:0}}>
      <div style={{position:"absolute",top:2,left:on?20:2,width:18,height:18,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.2)"}}/>
    </div>
  </label>
);
export const Badge=({children,color=C.primary,bg=C.primaryLight})=><span style={{padding:"2px 10px",borderRadius:20,fontSize:11,fontWeight:700,color,background:bg,whiteSpace:"nowrap"}}>{children}</span>;
export const StatCard=({label,value,sub,icon,color=C.primary,bg=C.primaryLight})=>(
  <div style={{background:bg,border:`2px solid ${color}22`,borderRadius:12,padding:20,display:"flex",alignItems:"center",gap:16,boxShadow:`0 2px 8px ${color}18`}}>
    <div style={{width:48,height:48,borderRadius:12,background:color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,flexShrink:0,boxShadow:`0 4px 12px ${color}40`}}>{icon}</div>
    <div><div style={{fontSize:22,fontWeight:800,color}}>{value}</div><div style={{fontSize:12,color:C.text,fontWeight:600,opacity:0.8}}>{label}</div>{sub&&<div style={{fontSize:11,color,marginTop:2,fontWeight:600}}>{sub}</div>}</div>
  </div>
);
export const Modal=({title,onClose,children,width=520})=>(
  <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.45)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
    <div style={{background:"#fff",borderRadius:16,width,maxWidth:"95vw",maxHeight:"90vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}}>
      <div style={{padding:"20px 24px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,background:"#fff",zIndex:1}}>
        <span style={{fontSize:16,fontWeight:700,color:C.text}}>{title}</span>
        <button onClick={onClose} style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:C.textLight}}>×</button>
      </div>
      <div style={{padding:24}}>{children}</div>
    </div>
  </div>
);
export const DataTable=({headers,rows,emptyMsg="No data"})=>(
  <div style={{overflowX:"auto"}}>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
      <thead><tr style={{background:C.bg}}>{headers.map(h=><th key={h} style={{padding:"10px 14px",textAlign:"left",fontWeight:700,color:C.textMid,fontSize:11,textTransform:"uppercase",letterSpacing:"0.05em",borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
      <tbody>{rows.length===0?<tr><td colSpan={headers.length} style={{textAlign:"center",padding:32,color:C.textLight}}>{emptyMsg}</td></tr>:rows.map((row,i)=><tr key={i} style={{borderBottom:`1px solid ${C.border}`,background:i%2===0?"#fff":"#FAFBFC"}}>{row.map((cell,j)=><td key={j} style={{padding:"10px 14px",color:C.text,verticalAlign:"middle"}}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>
);
