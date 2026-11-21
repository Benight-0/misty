package main
import("testing";"strings")
func TestPersonalSendValidation(t *testing.T){
 good:=personalSend{ID:"chat-11111111-1111-1111-1111-111111111111",Chat:"123@s.whatsapp.net",Body:"hello"}
 if !validatePersonalSend(good){t.Fatal("valid DM rejected")}
 for _,chat:=range []string{"123@lid","123-456@g.us"}{p:=good;p.Chat=chat;if !validatePersonalSend(p){t.Fatal("valid JID rejected")}}
 for _,chat:=range []string{"123@broadcast","status@broadcast","123@newsletter","https://example.com"}{p:=good;p.Chat=chat;if validatePersonalSend(p){t.Fatal("invalid JID accepted")}}
 for _,body:=range []string{" ","bad\x00text",strings.Repeat("x",20001),strings.Repeat("😀",10001)}{p:=good;p.Body=body;if validatePersonalSend(p){t.Fatal("invalid body accepted")}}
}
