package main

import (
 "context"
 "time"

 "go.mau.fi/whatsmeow"
 "go.mau.fi/whatsmeow/types"
 "go.mau.fi/whatsmeow/types/events"
)

type whatsappGroupPlan struct {
 ID string `json:"id"`
 Cutoff int64 `json:"cutoff"`
 Phase string `json:"phase"`
 Before string `json:"before"`
 At int64 `json:"at"`
 FromMe bool `json:"from_me"`
 Pages int `json:"pages"`
 KnownID string `json:"known_id"`
 KnownAt int64 `json:"known_ts"`
 KnownMe bool `json:"known_me"`
 RecentGap bool `json:"recent_gap"`
}
type whatsappHistoryPage struct {chat,id string;at int64;fromMe bool;count int}
type whatsappGroupHistory struct {plans []whatsappGroupPlan;cutoffs map[string]int64;pages chan whatsappHistoryPage}

func newWhatsAppGroupHistory(plans []whatsappGroupPlan)*whatsappGroupHistory {
 h:=&whatsappGroupHistory{cutoffs:map[string]int64{},pages:make(chan whatsappHistoryPage,128)}
 for _,p:=range plans {
  jid,err:=types.ParseJID(p.ID)
  if err!=nil||jid.Server!=types.GroupServer||p.Cutoff<=0 {continue}
  if p.At<=0 {p.At=p.Cutoff};if p.Phase=="" {p.Phase="recent"}
  h.plans=append(h.plans,p);h.cutoffs[p.ID]=p.Cutoff
 }
 return h
}

// Only historical sync payloads for the explicit G allowlist reach storage.
// Normal live group messages still go through privateJID and are rejected.
func(h *whatsappGroupHistory)receive(ctx context.Context,client *whatsmeow.Client,e *events.HistorySync){
 for _,conversation:=range e.Data.GetConversations(){
  chat,err:=types.ParseJID(conversation.GetID());if err!=nil {continue}
  cutoff,selected:=h.cutoffs[chat.String()];if !selected {continue}
  page:=whatsappHistoryPage{chat:chat.String()}
  for _,item:=range conversation.GetMessages(){
   parsed,parseErr:=client.ParseWebMessage(chat,item.GetMessage());if parseErr!=nil {continue}
   at:=parsed.Info.Timestamp.UnixMilli();if at<=0||at>cutoff {continue}
   if page.id==""||at<page.at||(at==page.at&&parsed.Info.ID<page.id){page.id=parsed.Info.ID;page.at=at;page.fromMe=parsed.Info.IsFromMe}
   page.count++
   whatsappMessageKind(client,parsed,"whatsapp_group_history_message")
  }
  if e.Data.GetSyncType().String()=="ON_DEMAND" {
   select{case h.pages<-page:case<-ctx.Done():return}
  }
 }
}

func groupHistoryProgress(p whatsappGroupPlan,state string){
 emit(map[string]any{"kind":"whatsapp_group_import_status","chat":p.ID,"state":state,"phase":p.Phase,"before":p.Before,"at":p.At,"from_me":p.FromMe,"pages":p.Pages,"recent_gap":p.RecentGap})
}

// Finite, resumable historical download. No periodic or live group subscription.
// A request is a protocol message to our own primary phone, never a chat message.
func(h *whatsappGroupHistory)run(ctx context.Context,client *whatsmeow.Client){
 queue:=append([]whatsappGroupPlan(nil),h.plans...)
 seen:=map[string]bool{}
 retries:=map[string]int{}
 recentRetried:=map[string]bool{}
 pending:=map[string][]whatsappHistoryPage{}
 for len(queue)>0&&ctx.Err()==nil {
  p:=queue[0];queue=queue[1:]
  chat,err:=types.ParseJID(p.ID);if err!=nil {continue}
  groupHistoryProgress(p,"requesting")
  info:=&types.MessageInfo{MessageSource:types.MessageSource{Chat:chat,IsFromMe:p.FromMe},ID:p.Before,Timestamp:time.UnixMilli(p.At)}
  requestCtx,cancel:=context.WithTimeout(ctx,25*time.Second)
  _,err=client.SendPeerMessage(requestCtx,client.BuildHistorySyncRequest(info,50));cancel()
  if ctx.Err()!=nil{return}
  key:=p.ID+":"+p.Phase+":"+p.Before
  if err!=nil {
   if retries[key]<2 {retries[key]++;groupHistoryProgress(p,"retrying");queue=append(queue,p)}else{groupHistoryProgress(p,"request_failed")}
   continue
  }
  timer:=time.NewTimer(90*time.Second)
  var page whatsappHistoryPage
  received:=false
  // Replies can arrive after a previous request timed out. Preserve replies for
  // other selected chats instead of consuming and discarding their cursors.
  for _,candidate:=range pending[p.ID] {
   if candidate.count==0||candidate.at<p.At||(candidate.at==p.At&&candidate.id!=p.Before){page=candidate;received=true;break}
  }
  delete(pending,p.ID)
 waitPage:
  for !received {
   select {
   case candidate:=<-h.pages:
    if candidate.chat!=p.ID {pending[candidate.chat]=append(pending[candidate.chat],candidate);continue}
    // A delayed duplicate is not evidence that older history is exhausted.
    if candidate.count>0&&(candidate.at>p.At||candidate.id==p.Before){continue}
    page=candidate;received=true;break waitPage
   case<-timer.C:break waitPage
   case<-ctx.Done():timer.Stop();return
   }
  }
  timer.Stop()
  if !received {
   if retries[key]<2 {retries[key]++;groupHistoryProgress(p,"retrying");queue=append(queue,p);continue}
   // Older bridge history provides a real cursor when a phone won't bootstrap
   // a recent page. Persist the missing recent span instead of claiming full sync.
   if p.Phase=="recent"&&p.KnownID!="" {
    p.Phase="older";p.Before=p.KnownID;p.At=p.KnownAt;p.FromMe=p.KnownMe;p.RecentGap=true
    groupHistoryProgress(p,"downloading");queue=append(queue,p)
   }else if p.RecentGap&&!recentRetried[p.ID] {
    // Some phones signal the older boundary by silence rather than an empty
    // page. Still attempt the unverified newer span before settling the import.
    recentRetried[p.ID]=true;p.Phase="recent";p.Before="";p.At=p.Cutoff;p.FromMe=false
    groupHistoryProgress(p,"retrying");queue=append(queue,p)
   }else{groupHistoryProgress(p,"phone_unavailable")}
   continue
  }
  p.Pages++
  // Keep the newer-span pass distinct until it overlaps the older archive.
  // Only that overlap proves the previously missing recent span was traversed.
  if p.Phase=="recent"&&p.RecentGap&&p.KnownAt>0&&page.count>0&&page.at<=p.KnownAt {p.RecentGap=false;p.Phase="older"}
  cursor:=p.ID+":"+page.id
  if page.count==0||page.id==""||page.id==p.Before||seen[cursor]||page.at>p.At {
   if page.count>0&&page.at<=p.At {p.Before=page.id;p.At=page.at;p.FromMe=page.fromMe}
   // The initial newest-page attempt may have failed while the phone was away.
   // Once the older pass settles, make one fresh attempt to close that gap.
   if p.RecentGap&&!recentRetried[p.ID] {
    recentRetried[p.ID]=true;p.Phase="recent";p.Before="";p.At=p.Cutoff;p.FromMe=false
    groupHistoryProgress(p,"retrying");queue=append(queue,p);continue
   }
   groupHistoryProgress(p,"available_exhausted");continue
  }
  seen[cursor]=true
  if p.Phase!="recent"||!p.RecentGap {p.Phase="older"}
  p.Before=page.id;p.At=page.at;p.FromMe=page.fromMe
  groupHistoryProgress(p,"downloading");queue=append(queue,p)
  select{case<-ctx.Done():return;case<-time.After(time.Second):}
 }
}
