// ═══════════════════════════════════════════════════════════════════
// ERROR BOUNDARIES — keep one broken screen from crashing the whole app.
// Extracted verbatim from App.jsx; markup and logic unchanged.
// ═══════════════════════════════════════════════════════════════════
import { Component } from "react";

// Lightweight per-section boundary — keeps one broken tab from white-screening the app.
export class TabBoundary extends Component {
  constructor(props){super(props);this.state={hasError:false,msg:""};}
  static getDerivedStateFromError(error){return{hasError:true,msg:error?.message||"Error"};}
  componentDidCatch(error,info){
    try{const logs=JSON.parse(localStorage.getItem("restopos_error_logs")||"[]");logs.unshift({ts:new Date().toISOString(),message:error?.message||"Unknown",where:this.props.name||"tab"});localStorage.setItem("restopos_error_logs",JSON.stringify(logs.slice(0,50)));}catch(e){}
  }
  render(){
    if(this.state.hasError){
      return(
        <div style={{padding:30,textAlign:"center",background:"#fff",border:"1px solid #eee",borderRadius:14,maxWidth:460,margin:"20px auto"}}>
          <div style={{fontSize:38,marginBottom:10}}>⚠️</div>
          <div style={{fontSize:16,fontWeight:800,color:"#D94040",marginBottom:6}}>This section hit an error</div>
          <div style={{fontSize:12,color:"#888",marginBottom:18}}>{this.state.msg}</div>
          <button onClick={()=>{try{localStorage.setItem("restopos_screen","dashboard");}catch(e){}window.location.reload();}}
            style={{padding:"11px 24px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Go to Dashboard</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export class ErrorBoundary extends Component {
  constructor(props){super(props);this.state={hasError:false,error:null};}
  static getDerivedStateFromError(error){return{hasError:true,error};}
  componentDidCatch(error,info){
    const logs=JSON.parse(localStorage.getItem("restopos_error_logs")||"[]");
    logs.unshift({ts:new Date().toISOString(),message:error?.message||"Unknown",stack:error?.stack?.slice(0,400)||"",component:info?.componentStack?.slice(0,200)||""});
    localStorage.setItem("restopos_error_logs",JSON.stringify(logs.slice(0,50)));
  }
  render(){
    if(this.state.hasError){
      return(
        <div style={{minHeight:"100vh",background:"#0a1628",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Plus Jakarta Sans',sans-serif",padding:20}}>
          <div style={{background:"#1a2332",border:"1px solid rgba(217,64,64,0.4)",borderRadius:20,padding:40,maxWidth:480,textAlign:"center"}}>
            <div style={{fontSize:48,marginBottom:16}}>⚠️</div>
            <div style={{fontSize:20,fontWeight:800,color:"#ff6b6b",marginBottom:8}}>Something went wrong</div>
            <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:24,lineHeight:1.6}}>{this.state.error?.message||"An unexpected error occurred."}</div>
            <button onClick={()=>{try{localStorage.setItem("restopos_screen","dashboard");}catch(e){}this.setState({hasError:false,error:null});window.location.reload();}} style={{padding:"12px 28px",background:"linear-gradient(135deg,#1A6B4A,#134D36)",color:"#fff",border:"none",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",marginRight:10}}>Try Again</button>
            <button onClick={()=>{try{localStorage.setItem("restopos_screen","dashboard");}catch(e){}window.location.reload();}} style={{padding:"12px 28px",background:"rgba(255,255,255,0.1)",color:"#fff",border:"1px solid rgba(255,255,255,0.2)",borderRadius:10,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Reload App</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
