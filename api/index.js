import dashboardApiProxyHandler from './[...path].js'

function rewriteApiUrlFromProxyQuery(req) {
  const requestUrl = new URL(req.url || '/api', 'http://localhost')
  const rawPath = String(requestUrl.searchParams.get('__path') || '').trim()
  if (!rawPath) return

  requestUrl.searchParams.delete('__path')

  let decodedPath = rawPath
  try {
    decodedPath = decodeURIComponent(rawPath)
  } catch {
    decodedPath = rawPath
  }
  decodedPath = decodedPath.replace(/^\/+/, '')

  const nextPathname = decodedPath ? `/api/${decodedPath}` : '/api'
  const nextQuery = requestUrl.searchParams.toString()
  req.url = nextQuery ? `${nextPathname}?${nextQuery}` : nextPathname
}

export default async function dashboardApiIndexHandler(req, res) {
  rewriteApiUrlFromProxyQuery(req)
  await dashboardApiProxyHandler(req, res)
}
