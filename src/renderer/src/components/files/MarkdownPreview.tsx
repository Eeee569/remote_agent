import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const MD_CSS = `
.ra-md {
  padding: 16px;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ra-text);
  word-wrap: break-word;
}
.ra-md > :first-child { margin-top: 0; }
.ra-md h1, .ra-md h2, .ra-md h3, .ra-md h4, .ra-md h5, .ra-md h6 {
  margin: 1.1em 0 0.4em;
  line-height: 1.25;
  font-weight: 600;
}
.ra-md h1 { font-size: 1.55em; border-bottom: 1px solid var(--ra-border); padding-bottom: 0.25em; }
.ra-md h2 { font-size: 1.3em; }
.ra-md h3 { font-size: 1.12em; }
.ra-md h4 { font-size: 1em; }
.ra-md p { margin: 0.5em 0; }
.ra-md a { color: var(--ra-accent); text-decoration: none; }
.ra-md a:hover { text-decoration: underline; }
.ra-md code {
  font-family: var(--ra-mono);
  font-size: 0.9em;
  background: var(--ra-bg);
  border: 1px solid var(--ra-border);
  border-radius: 4px;
  padding: 1px 5px;
}
.ra-md pre {
  background: var(--ra-bg);
  border: 1px solid var(--ra-border);
  border-radius: 6px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 0.6em 0;
}
.ra-md pre code { background: none; border: none; padding: 0; font-size: 12px; }
.ra-md ul, .ra-md ol { margin: 0.4em 0; padding-left: 1.6em; }
.ra-md li { margin: 0.15em 0; }
.ra-md table { border-collapse: collapse; margin: 0.6em 0; display: block; overflow-x: auto; }
.ra-md th, .ra-md td { border: 1px solid var(--ra-border-strong); padding: 4px 10px; }
.ra-md th { background: var(--ra-bg-raised); }
.ra-md blockquote {
  margin: 0.6em 0;
  padding: 2px 12px;
  border-left: 3px solid var(--ra-border-strong);
  color: var(--ra-text-dim);
}
.ra-md hr { border: none; border-top: 1px solid var(--ra-border); margin: 1em 0; }
.ra-md img { max-width: 100%; }
.ra-md input[type='checkbox'] { margin-right: 6px; }
`

/** Styled GitHub-flavoured markdown rendering for the file viewer. */
export default function MarkdownPreview({ content }: { content: string }): React.JSX.Element {
  return (
    <div className='ra-md'>
      <style>{MD_CSS}</style>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
