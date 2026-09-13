// Pure transcript file list for the Mac runner's existing Room mirror.
// No database, clock, model calls or git: the same data always gives the same files.
export const CONVOS_REPO_PATH = 'queue-server/project-docs/conversations';

function slug(title) {
  return String(title || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
}

export function convoFiles(convos = []) {
  const files = [];
  const indexLines = [];
  for (const convo of convos) {
    const title = String(convo.title || 'Untitled conversation').replace(/[\r\n]+/g, ' ');
    const filename = `${slug(title)}-${String(convo.id).slice(0, 8)}.md`;
    const messages = (convo.messages || []).map((message) => {
      const text = String(message.content || '');
      const body = text.length > 8000 ? `${text.slice(0, 8000)}…(cut)` : text;
      return `## ${message.role === 'user' ? 'you' : 'the room'}\n\n${body}`;
    });
    files.push({
      path: `${CONVOS_REPO_PATH}/${filename}`,
      content: `# ${title}\n\nThread ${convo.id} · ${convo.turns} turns · last said ${convo.updated_at}\n\n${messages.join('\n\n')}\n`,
    });
    indexLines.push(`- ${title} — conversations/${filename}`);
  }
  files.push({
    path: `${CONVOS_REPO_PATH}/index.md`,
    content: '# Room conversations\n\nRaw transcripts, mirrored automatically for coding agents after at least three user messages.\n'
      + '\nCurated /note saves live separately in notes/. A conversation can have both a note and a raw transcript; both are kept.\n\n'
      + (indexLines.length ? `${indexLines.join('\n')}\n` : 'No conversations to mirror yet.\n'),
  });
  return files;
}
