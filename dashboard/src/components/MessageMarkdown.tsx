import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

// Main conversation and passage discussions use the same renderer. Keeping
// this pure also prevents historical messages from re-parsing on each delta.
export const MessageMarkdown = memo(function MessageMarkdown({ text }: { text: string }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkBreaks]}
    components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}
  >{text}</ReactMarkdown>
})
