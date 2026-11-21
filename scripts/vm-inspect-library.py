import pathlib
base=pathlib.Path('/home/ubuntu/go/pkg/mod/github.com/beeper')
for folder in base.glob('discordgo*'):
    for source in folder.glob('*.go'):
        text=source.read_text()
        if 'func (s *Session) AddHandler' in text or 'case func(' in text:
            print(source.name)
            for i,line in enumerate(text.splitlines()):
                if 'func (s *Session) AddHandler' in line or 'case func(' in line or 'func (s *Session) handleEvent' in line:
                    print(i+1,line)
