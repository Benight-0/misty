package main

import (
 "context"
 "crypto/sha256"
 "crypto/subtle"
 "encoding/hex"
 "encoding/json"
 "net"
 "net/http"
 "os"
 "regexp"
 "strings"
 "sync"
 "time"
 "unicode/utf16"

 "go.mau.fi/whatsmeow"
 "go.mau.fi/whatsmeow/proto/waE2E"
 "go.mau.fi/whatsmeow/types"
 "google.golang.org/protobuf/proto"
)

type personalSend struct { ID string `json:"id"`; Chat string `json:"chat"`; Body string `json:"body"` }
var submissionID=regexp.MustCompile(`^chat-[a-f0-9-]{36}$`)
var recipientJID=regexp.MustCompile(`^\d+(?:-\d+)?@(s\.whatsapp\.net|lid|g\.us)$`)

func validatePersonalSend(p personalSend) bool {
 return submissionID.MatchString(p.ID)&&recipientJID.MatchString(p.Chat)&&strings.TrimSpace(p.Body)!=""&&!strings.ContainsRune(p.Body,0)&&len(utf16.Encode([]rune(p.Body)))<=20000
}

// This endpoint is loopback-only, with a separate sender credential. The Node
// approval journal is the only bot-side caller; this client reuses the linked session.
func startWhatsAppSender(ctx context.Context, client *whatsmeow.Client) func() {
 token,err:=os.ReadFile(os.Getenv("ARCHIVAL_MESSAGE_TOKEN_FILE"));if err!=nil||len(strings.TrimSpace(string(token)))<32{return func(){}}
 expected:=[]byte("Bearer "+strings.TrimSpace(string(token)))
 listener,err:=net.Listen("tcp","127.0.0.1:8796");if err!=nil{return func(){}}
 var mu sync.Mutex
 // Bounded receipts prevent accidental concurrent replay within this process.
 cache:=map[string]map[string]any{};requests:=map[string]personalSend{};order:=[]string{}
 handler:=http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")),expected)!=1{w.WriteHeader(401);return}
  if r.Method!="POST"||(r.URL.Path!="/inspect"&&r.URL.Path!="/send"){w.WriteHeader(404);return}
  r.Body=http.MaxBytesReader(w,r.Body,100000)
  var p personalSend;if json.NewDecoder(r.Body).Decode(&p)!=nil||!recipientJID.MatchString(p.Chat){w.WriteHeader(400);return}
  if client.Store.ID==nil||client.Store.ID.User!="910000000001"||!client.IsConnected()||!client.IsLoggedIn(){w.WriteHeader(503);return}
  if r.URL.Path=="/inspect"{w.Header().Set("Content-Type","application/json");json.NewEncoder(w).Encode(map[string]any{"ready":true});return}
  if !validatePersonalSend(p){w.WriteHeader(400);return}
  mu.Lock();defer mu.Unlock()
  if old,ok:=requests[p.ID];ok{
   if old!=p{w.WriteHeader(409);return}
   receipt:=cache[p.ID];if receipt==nil{w.WriteHeader(502);return}
   w.Header().Set("Content-Type","application/json");json.NewEncoder(w).Encode(receipt);return
  }
  jid,err:=types.ParseJID(p.Chat);if err!=nil{w.WriteHeader(400);return}
  requests[p.ID]=p;order=append(order,p.ID)
  if len(order)>256{delete(cache,order[0]);delete(requests,order[0]);order=order[1:]}
  digest:=sha256.Sum256([]byte(p.ID));messageID:="3EB0"+strings.ToUpper(hex.EncodeToString(digest[:9]))
  sendCtx,cancel:=context.WithTimeout(ctx,30*time.Second);defer cancel()
  result,err:=client.SendMessage(sendCtx,jid,&waE2E.Message{Conversation:proto.String(p.Body)},whatsmeow.SendRequestExtra{ID:messageID,Timeout:25*time.Second})
  if err!=nil{w.WriteHeader(502);return} // No automatic retry after uncertain delivery.
  receipt:=map[string]any{"kind":"whatsapp_message","id":result.ID,"chat":p.Chat,"aliases":[]string{p.Chat},"sender":client.Store.ID.ToNonAD().String(),"is_me":true,"name":"You","at":result.Timestamp.UnixMilli(),"body":p.Body,"type":"m.text"}
  cache[p.ID]=receipt;w.Header().Set("Content-Type","application/json");json.NewEncoder(w).Encode(receipt)
 })
 server:=&http.Server{Handler:handler,ReadHeaderTimeout:5*time.Second,ReadTimeout:10*time.Second,WriteTimeout:40*time.Second,IdleTimeout:30*time.Second}
 go server.Serve(listener)
 return func(){server.Close()}
}
