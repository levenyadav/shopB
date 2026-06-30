// Developer / powered-by credit. Shown in the app footer (ShopLayout) and on the
// public Login page. Links open in a new tab; rel guards the opener + SEO juice.
export default function Credit({ className = '' }) {
  return (
    <p className={`text-xs text-muted ${className}`}>
      Developed by{' '}
      <a
        href="https://www.advertizerdigitalpowerhouse.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-ink hover:text-peacock underline-offset-2 hover:underline"
      >
        Advertizer Digital Powerhouse
      </a>
      {' · '}Powered by{' '}
      <a
        href="https://voyler.org/"
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-ink hover:text-peacock underline-offset-2 hover:underline"
      >
        Voyler
      </a>
    </p>
  )
}
