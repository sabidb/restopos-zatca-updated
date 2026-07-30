// ═══════════════════════════════════════════════════════════════════
// RECIPE COSTING — per-item ingredient cost breakdown.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { fmtSAR } from "../lib/format.js";
import { Card, Btn, DataTable } from "../components/ui.jsx";

export function RecipeCosting({items}){
  const [selectedItem,setSelectedItem]=useState(null);
  const [recipes,setRecipes]=useState(()=>JSON.parse(localStorage.getItem("restopos_recipes")||"{}"));
  const [editMode,setEditMode]=useState(false);
  const [draftIngredients,setDraftIngredients]=useState([]);
  function openItem(item){
    setSelectedItem(item);
    setDraftIngredients(recipes[item.id]||[{name:"",unit:"g",qty:"",cost:""}]);
    setEditMode(false);
  }
  function addIngredient(){setDraftIngredients(prev=>[...prev,{name:"",unit:"g",qty:"",cost:""}]);}
  function removeIngredient(i){setDraftIngredients(prev=>prev.filter((_,j)=>j!==i));}
  function updateIngredient(i,field,val){setDraftIngredients(prev=>prev.map((ing,j)=>j===i?{...ing,[field]:val}:ing));}
  function saveRecipe(){
    const updated={...recipes,[selectedItem.id]:draftIngredients};
    setRecipes(updated);localStorage.setItem("restopos_recipes",JSON.stringify(updated));
    setEditMode(false);
  }
  function totalCost(itemId){
    const ings=recipes[itemId]||[];
    return ings.reduce((s,ing)=>s+parseFloat(ing.cost||0),0);
  }
  return(
    <div style={{display:"flex",gap:20}}>
      <div style={{width:280,flexShrink:0}}>
        <Card style={{padding:12}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>Menu Items</div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {items.map(it=>{
              const cost=totalCost(it.id);
              const margin=it.price>0?((it.price-cost)/it.price*100).toFixed(0):0;
              return(
                <button key={it.id} onClick={()=>openItem(it)} style={{padding:"10px 12px",borderRadius:8,border:`1.5px solid ${selectedItem?.id===it.id?C.primary:C.border}`,background:selectedItem?.id===it.id?C.primaryLight:"#fff",textAlign:"left",cursor:"pointer",fontFamily:"inherit"}}>
                  <div style={{fontSize:13,fontWeight:700,color:C.text}}>{it.name}</div>
                  <div style={{fontSize:11,color:C.textMid,marginTop:2}}>SAR {it.price} · Cost: SAR {cost.toFixed(2)} · Margin: <span style={{color:margin>60?C.success:margin>30?C.warning:C.danger,fontWeight:700}}>{margin}%</span></div>
                </button>
              );
            })}
          </div>
        </Card>
      </div>
      <div style={{flex:1}}>
        {selectedItem?(
          <Card>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:16,fontWeight:800}}>{selectedItem.name}</div>
                <div style={{fontSize:13,color:C.textMid}}>Selling price: SAR {selectedItem.price}</div>
              </div>
              <Btn size="sm" variant={editMode?"ghost":"outline"} onClick={()=>setEditMode(e=>!e)}>{editMode?"Cancel":"✏️ Edit Recipe"}</Btn>
            </div>
            {editMode?(
              <>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                    <thead><tr style={{background:C.bg}}>{["Ingredient","Unit","Qty","Cost (SAR)",""].map(h=><th key={h} style={{padding:"8px 12px",textAlign:"left",fontWeight:700,color:C.textMid,fontSize:11,borderBottom:`1px solid ${C.border}`}}>{h}</th>)}</tr></thead>
                    <tbody>{draftIngredients.map((ing,i)=>(
                      <tr key={i} style={{borderBottom:`1px solid ${C.border}`}}>
                        <td style={{padding:"8px 12px"}}><input value={ing.name} onChange={e=>updateIngredient(i,"name",e.target.value)} placeholder="e.g. Chicken" style={{padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,fontFamily:"inherit",width:140}}/></td>
                        <td style={{padding:"8px 12px"}}><select value={ing.unit} onChange={e=>updateIngredient(i,"unit",e.target.value)} style={{padding:"6px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12}}>{["g","kg","ml","L","pcs","tsp","tbsp"].map(u=><option key={u}>{u}</option>)}</select></td>
                        <td style={{padding:"8px 12px"}}><input type="number" value={ing.qty} onChange={e=>updateIngredient(i,"qty",e.target.value)} placeholder="0" style={{padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,fontFamily:"inherit",width:70}}/></td>
                        <td style={{padding:"8px 12px"}}><input type="number" value={ing.cost} onChange={e=>updateIngredient(i,"cost",e.target.value)} placeholder="0.00" style={{padding:"6px 10px",border:`1px solid ${C.border}`,borderRadius:6,fontSize:12,fontFamily:"inherit",width:80}}/></td>
                        <td style={{padding:"8px 12px"}}><button onClick={()=>removeIngredient(i)} style={{background:C.dangerLight,color:C.danger,border:"none",borderRadius:6,padding:"4px 8px",cursor:"pointer",fontWeight:700}}>✕</button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <div style={{display:"flex",gap:10,marginTop:14}}>
                  <Btn variant="ghost" size="sm" onClick={addIngredient}>+ Add Ingredient</Btn>
                  <Btn size="sm" onClick={saveRecipe}>💾 Save Recipe</Btn>
                </div>
              </>
            ):(
              <>
                {(recipes[selectedItem.id]||[]).length===0?(
                  <div style={{textAlign:"center",padding:"30px 0",color:C.textLight}}>No recipe added yet. Click "Edit Recipe" to add ingredients.</div>
                ):(
                  <>
                    <DataTable headers={["Ingredient","Unit","Qty","Cost (SAR)"]} rows={(recipes[selectedItem.id]||[]).map(ing=>[ing.name,ing.unit,ing.qty,fmtSAR(parseFloat(ing.cost||0))])}/>
                    <div style={{marginTop:16,padding:"14px 16px",background:C.bg,borderRadius:10,display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
                      {[["Total Recipe Cost",fmtSAR(totalCost(selectedItem.id)),C.danger],["Selling Price",fmtSAR(selectedItem.price),C.primary],["Gross Margin",((selectedItem.price-totalCost(selectedItem.id))/selectedItem.price*100).toFixed(1)+"%",C.success]].map(([l,v,c])=>(
                        <div key={l} style={{textAlign:"center"}}><div style={{fontSize:11,color:C.textMid}}>{l}</div><div style={{fontSize:18,fontWeight:800,color:c}}>{v}</div></div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </Card>
        ):<Card><div style={{textAlign:"center",padding:"60px 0",color:C.textLight}}><div style={{fontSize:40,marginBottom:12}}>📋</div><div>Select a menu item to view or edit its recipe</div></div></Card>}
      </div>
    </div>
  );
}
