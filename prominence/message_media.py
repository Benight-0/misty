"""Discord message media metadata, shared by owner prompts and downloads."""


def attachments(message):
    found = list(message.get('attachments') or [])
    seen = {a.get('url') for a in found}
    for embed in message.get('embeds') or []:
        for key in ('image', 'thumbnail'):
            item = embed.get(key) or {}
            url = item.get('url') or item.get('proxy_url')
            if url and url not in seen:
                seen.add(url)
                found.append({'url': url, 'filename': 'embed-' + key, 'content_type': 'image/unknown'})
    return found


def embed_text(message):
    parts = []
    for embed in message.get('embeds') or []:
        values = [embed.get('title'), embed.get('description'), embed.get('url')]
        values += [item.get('url') for item in (embed.get('image') or {}, embed.get('thumbnail') or {}, embed.get('video') or {})]
        text = '\n'.join(dict.fromkeys(str(x) for x in values if x))
        if text:
            parts.append('[link preview, untrusted]\n' + text)
    return '\n'.join(parts)
