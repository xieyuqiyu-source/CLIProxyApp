export function ProviderIcon({ id, className = '' }: { id: string; className?: string }) {
  switch (id) {
    case 'codex':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0462 6.0462 0 0 0 5.45-3.15 6.0557 6.0557 0 0 0 3.572-6.1181zM11.69 22.181a4.1165 4.1165 0 0 1-3.1444-1.464 4.0927 4.0927 0 0 1-1.0425-3.322l7.1517 4.148a4.1032 4.1032 0 0 1-2.9648.638zm-6.208-2.464a4.119 4.119 0 0 1-1.6377-2.9935 4.0945 4.0945 0 0 1 2.2795-2.6186l7.147 4.148-3.5786 2.062a4.105 4.105 0 0 1-4.21-.6zm-2.0326-6.866a4.1175 4.1175 0 0 1 1.5067-3.12 4.0932 4.0932 0 0 1 3.3205-.8844v8.2818l-3.5833-2.091a4.1126 4.1126 0 0 1-1.244-2.1864zm10.5186-6.155a3.9877 3.9877 0 0 1 3.13 1.459 3.9686 3.9686 0 0 1 1.0426 3.317l-7.152-4.144 2.9794-.632zm6.208 2.459a3.9902 3.9902 0 0 1 1.6377 2.9934 3.974 3.974 0 0 1-2.2795 2.619l-7.1518-4.144 3.5834-2.062a3.9877 3.9877 0 0 1 4.21.594zm2.0326 6.867a3.9877 3.9877 0 0 1-1.5067 3.12 3.9686 3.9686 0 0 1-3.325.8795v-8.2818l3.5833 2.0667a4.0044 4.0044 0 0 1 1.2484 2.2156zm-10.5186 1.439v-4.133l-3.5834-2.066L8.1432 10v4.133L11.7266 16.2z" />
        </svg>
      )
    case 'anthropic':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12.923 7h-1.846L3.5 21h2.5l1.9-4h8.2l1.9 4h2.5L12.923 7zm-3.1 9.5l2.177-4.58 2.177 4.58h-4.354z" />
        </svg>
      )
    case 'antigravity':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <circle cx="12" cy="12" r="3" />
          <path fillRule="evenodd" clipRule="evenodd" d="M12 2.5C17.2467 2.5 21.5 6.75329 21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C6.75329 21.5 2.5 17.2467 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5ZM12 4.5C7.85786 4.5 4.5 7.85786 4.5 12C4.5 16.1421 7.85786 19.5 12 19.5C16.1421 19.5 19.5 16.1421 19.5 12C19.5 7.85786 16.1421 4.5 12 4.5Z" />
        </svg>
      )
    case 'gemini-cli':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 2C12 7.523 16.477 12 22 12C16.477 12 12 16.477 12 22C12 16.477 7.523 12 2 12C7.523 12 12 7.523 12 2Z" />
        </svg>
      )
    case 'xai':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M4.25 4h4.16l3.74 5.15L16.63 4h3.12l-6.06 6.96L20.25 20h-4.16l-4.08-5.62L7.12 20H4l6.45-7.41L4.25 4zm2.79 1.54 9.84 12.92h.98L8.03 5.54h-.99z" />
        </svg>
      )
    case 'kimi':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M20.25 13.51A9 9 0 1 1 10.49 3.75 7.5 7.5 0 0 0 20.25 13.51z" />
        </svg>
      )
    case 'qwen':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <circle cx="11" cy="11" r="8" />
          <path d="M16.5 16.5L21 21" />
        </svg>
      )
    default:
      return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <path d="M12 8v8" />
          <path d="M8 12h8" />
        </svg>
      )
  }
}
