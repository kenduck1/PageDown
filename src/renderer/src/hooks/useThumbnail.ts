import { useEffect, useState } from 'react'

interface ThumbnailState {
  dataUrl: string | null
  pageCount: number | null
  loading: boolean
}

export function useThumbnail(
  key: string,
  fetcher: () => Promise<{ dataUrl: string; pageCount: number }>
): ThumbnailState {
  const [prevKey, setPrevKey] = useState(key)
  const [state, setState] = useState<ThumbnailState>({
    dataUrl: null,
    pageCount: null,
    loading: true
  })

  if (prevKey !== key) {
    setPrevKey(key)
    setState({ dataUrl: null, pageCount: null, loading: true })
  }

  useEffect(() => {
    let cancelled = false

    fetcher()
      .then((result) => {
        if (!cancelled) {
          setState({ dataUrl: result.dataUrl, pageCount: result.pageCount, loading: false })
        }
      })
      .catch(() => {
        if (!cancelled) setState({ dataUrl: null, pageCount: null, loading: false })
      })

    return () => {
      cancelled = true
    }
    // Deliberately excluded from deps: callers pass a fresh closure every
    // render, and depending on it would refetch every render instead of
    // only on key change, which is the entire point of this hook's `key`
    // parameter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return state
}
