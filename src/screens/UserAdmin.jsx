// ═══════════════════════════════════════════════════════════════════
// USER MANAGEMENT — add/edit/delete app users (Admin/Manager/Cashier).
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { useState } from "react";
import { C } from "../lib/theme.js";
import { Card, Btn, Inp, Sel, Modal, Badge, DataTable } from "../components/ui.jsx";

export function UserAdmin({users,setUsers,plan,lang="en"}){
  const [showModal,setShowModal]=useState(false);const [editUser,setEditUser]=useState(null);const blank={name:"",username:"",role:"Cashier",active:true};const [form,setForm]=useState(blank);
  // User-count limit for the current plan. null = unlimited (Premium).
  const maxUsers=plan?.limits?.users??null;
  const atLimit=maxUsers!=null&&users.length>=maxUsers;
    function openModal(u=null){
      // Block only NEW users past the plan cap; editing existing users is always allowed.
      if(!u&&atLimit){
        alert(`Your ${plan?.name||"Basic"} plan includes up to ${maxUsers} users. You've reached that limit.\n\nUpgrade your plan (Help → Support) to add more users.`);
        return;
      }
      setEditUser(u);setForm(u?{...u}:{...blank});setShowModal(true);
    }
  function save(){
    if(!form.name||!form.username)return alert("Name and username required");
    if(!editUser&&atLimit){alert(`Your ${plan?.name||"Basic"} plan is limited to ${maxUsers} users. Upgrade to add more.`);return;}
    setUsers(prev=>editUser?prev.map(u=>u.id===editUser.id?{...form,id:editUser.id}:u):[...prev,{...form,id:Date.now(),lastLogin:"Never"}]);setShowModal(false);
  }
  return(<div>
    {showModal&&<Modal title={editUser?"Edit User":"New User"} onClose={()=>setShowModal(false)} width={420}>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Inp label="Full Name" value={form.name} onChange={v=>setForm(f=>({...f,name:v}))}/><Inp label="Username" value={form.username} onChange={v=>setForm(f=>({...f,username:v}))}/>
        <Sel label="Role" value={form.role} onChange={v=>setForm(f=>({...f,role:v}))} options={["Admin","Manager","Cashier"]}/>
        <div style={{display:"flex",alignItems:"center",gap:8}}><input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))} id="ua"/><label htmlFor="ua" style={{fontSize:13}}>Active</label></div>
      </div>
      <div style={{display:"flex",gap:10,marginTop:16}}><Btn variant="ghost" onClick={()=>setShowModal(false)} style={{flex:1}}>Cancel</Btn><Btn onClick={save} style={{flex:1}}>Save</Btn></div>
    </Modal>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,flexWrap:"wrap",gap:10}}>
      <div style={{fontSize:18,fontWeight:800,color:C.text}}>👤 User Management
        <span style={{fontSize:12,fontWeight:600,color:atLimit?C.danger:C.textMid,marginLeft:10}}>
          {users.length}{maxUsers!=null?` / ${maxUsers}`:""} users{maxUsers!=null?` · ${plan?.name} plan`:""}
        </span>
      </div>
      <div style={{display:"flex",gap:10}}>

        <Btn size="sm" onClick={()=>openModal()} disabled={atLimit} title={atLimit?`${plan?.name} plan limit reached — upgrade to add more users`:""}>+ New User</Btn>
      </div>
    </div>
    <Card><DataTable headers={["Name","Username","Role","Status","Actions"]} rows={users.map(u=>[u.name,<span style={{fontFamily:"monospace"}}>{u.username}</span>,<Badge color={u.role==="Admin"?C.danger:u.role==="Manager"?C.warning:C.info} bg={u.role==="Admin"?C.dangerLight:u.role==="Manager"?C.warningLight:C.infoLight}>{u.role}</Badge>,<Badge color={u.active?C.success:C.danger} bg={u.active?C.successLight:C.dangerLight}>{u.active?"Active":"Off"}</Badge>,<div style={{display:"flex",gap:5}}><Btn size="sm" variant="ghost" onClick={()=>openModal(u)}>Edit</Btn><Btn size="sm" variant="danger" onClick={()=>{if(confirm("Delete?"))setUsers(prev=>prev.filter(x=>x.id!==u.id));}}>Del</Btn></div>])}/></Card>
  </div>);
}
