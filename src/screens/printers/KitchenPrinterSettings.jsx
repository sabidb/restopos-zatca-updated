// ═══════════════════════════════════════════════════
// KITCHEN PRINTER SETTINGS — configure the OS-dialog kitchen (KOT) printer:
// enable, name, paper width, auto-print, and a test KOT. Self-contained;
// separate from the QZ Tray engine. Extracted verbatim from App.jsx.
// ═══════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../../lib/theme.js";
import { LS } from "../../lib/storage.js";
import { Card, Btn, Inp } from "../../components/ui.jsx";

export function KitchenPrinterSettings(){
  const [kitchenPrinter,setKitchenPrinter]=useState(()=>LS.get("restopos_kitchen_printer")||{name:"Kitchen Printer",paperWidth:"80mm",autoKOT:true,enabled:false});
  const [kpSaved,setKpSaved]=useState(false);
  function saveKP(){LS.set("restopos_kitchen_printer",kitchenPrinter);setKpSaved(true);setTimeout(()=>setKpSaved(false),3000);}
  function testKOT(){
    const win=window.open("","_blank","width=340,height=500");if(!win){alert("Pop-up blocked.");return;}
    const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:${kitchenPrinter.paperWidth} auto;margin:0}body{font-family:'Courier New',monospace;font-size:14px;padding:8mm;width:${kitchenPrinter.paperWidth}}.center{text-align:center}.big{font-size:18px;font-weight:900}.hr{border:none;border-top:2px dashed #000;margin:6px 0}</style></head><body><div class="center"><div class="big">*** KOT TEST ***</div><div>Kitchen Order Ticket</div><div>${new Date().toLocaleTimeString()}</div></div><div class="hr"/><div>1x Broasted Chicken Half</div><div>2x French Fries</div><div>1x Fresh Lemon Juice</div><div class="hr"/><div class="center">Table 5 · Dine-in</div><script>window.onload=function(){window.print();window.close();}<\/script></body></html>`;
    win.document.write(html);win.document.close();
  }
  return(<Card style={{maxWidth:560}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:20}}>🍽️ Kitchen Printer (KOT)</div>
      <div style={{background:C.infoLight,border:`1px solid ${C.info}`,borderRadius:10,padding:"12px 16px",marginBottom:20,fontSize:13,color:C.info,fontWeight:600}}>ℹ️ Set up a second printer dedicated to printing Kitchen Order Tickets (KOTs) to the kitchen.</div>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700}}>Enable Kitchen Printer</div><div style={{fontSize:11,color:C.textMid}}>Auto-print KOT to kitchen on every order</div></div>
          <button onClick={()=>setKitchenPrinter(p=>({...p,enabled:!p.enabled}))} style={{width:44,height:24,borderRadius:12,background:kitchenPrinter.enabled?C.primary:"#ccc",border:"none",cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
            <span style={{position:"absolute",top:2,left:kitchenPrinter.enabled?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s",display:"block"}}/>
          </button>
        </div>
        <Inp label="Kitchen Printer Name / Label" value={kitchenPrinter.name||""} onChange={v=>setKitchenPrinter(p=>({...p,name:v}))} placeholder="e.g. Kitchen Printer, Grill Station"/>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <label style={{fontSize:12,fontWeight:600,color:C.textMid}}>Paper Width</label>
          <div style={{display:"flex",gap:8}}>
            {["58mm","80mm"].map(w=><button key={w} onClick={()=>setKitchenPrinter(p=>({...p,paperWidth:w}))} style={{flex:1,padding:"10px",border:`2px solid ${kitchenPrinter.paperWidth===w?C.primary:C.border}`,borderRadius:8,background:kitchenPrinter.paperWidth===w?C.primaryLight:"#fff",color:kitchenPrinter.paperWidth===w?C.primary:C.textMid,fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer"}}>{w}</button>)}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700}}>Auto-Print KOT on Checkout</div><div style={{fontSize:11,color:C.textMid}}>Automatically send KOT to kitchen when payment is confirmed</div></div>
          <button onClick={()=>setKitchenPrinter(p=>({...p,autoKOT:!p.autoKOT}))} style={{width:44,height:24,borderRadius:12,background:kitchenPrinter.autoKOT?C.primary:"#ccc",border:"none",cursor:"pointer",position:"relative",transition:"background 0.2s"}}>
            <span style={{position:"absolute",top:2,left:kitchenPrinter.autoKOT?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s",display:"block"}}/>
          </button>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10,padding:"14px 16px",background:C.bg,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{fontSize:12,fontWeight:700,color:C.textMid}}>SETUP INSTRUCTIONS</div>
          {[["1","Connect your kitchen printer via USB or Network to the same computer/device."],["2",`Set it as a secondary printer in your OS — name it "${kitchenPrinter.name||"Kitchen Printer"}".`],["3","RestoPOS will open a separate print dialog targeting that printer for KOTs."],["4","Use 80mm thermal paper for kitchen tickets (58mm if your printer is smaller)."]].map(([n,tx])=>(
            <div key={n} style={{display:"flex",gap:10}}><span style={{width:20,height:20,borderRadius:"50%",background:C.primary,color:"#fff",fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{n}</span><span style={{fontSize:12,color:C.textMid}}>{tx}</span></div>
          ))}
        </div>
        <div style={{display:"flex",gap:10}}>
          <Btn onClick={testKOT} variant="outline">🖨️ Test KOT Print</Btn>
          <Btn onClick={saveKP}>💾 Save Kitchen Settings</Btn>
          {kpSaved&&<span style={{fontSize:12,color:C.success,fontWeight:700,alignSelf:"center"}}>✓ Saved!</span>}
        </div>
      </div>
    </Card>);
}
