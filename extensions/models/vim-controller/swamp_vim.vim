" Swamp Vim runtime.
"
" Sourced into a running Vim server by @svendowideit/vim-controller. Every function is
" small, returns JSON, and is safe to call through `--remote-expr`. The
" extension owns the orchestration (exact-once checks, hashes, diffs); this
" file only touches the buffer, cursor, annotations and quickfix list.

function! SwampVimRuntime() abort
  return 6
endfunction

function! SwampVimStatus() abort
  return json_encode({
        \ 'file': expand('%:p'),
        \ 'modified': &modified,
        \ 'lines': line('$'),
        \ 'cursor': getpos('.'),
        \ 'mode': mode(),
        \ 'filetype': &filetype,
        \ 'name': bufname('%'),
        \ })
endfunction

function! SwampVimRead(mode) abort
  let has_selection = 0
  if a:mode ==# 'visible'
    let start = line('w0')
    let end = line('w$')
  elseif a:mode ==# 'selection'
    let start = line("'<")
    let end = line("'>")
    let has_selection = (start > 0 && end > 0)
    if !has_selection
      let start = 1
      let end = line('$')
    endif
  else
    let start = 1
    let end = line('$')
  endif
  return json_encode({
        \ 'file': expand('%:p'),
        \ 'modified': &modified,
        \ 'start': start,
        \ 'end': end,
        \ 'has_selection': has_selection,
        \ 'lines': getline(start, end),
        \ 'cursor': getpos('.'),
        \ 'mode': mode(),
        \ 'filetype': &filetype,
        \ })
endfunction

" Replace the buffer from a file on disk.
"
" Whole-file writes used to go through `--remote-expr` as one huge JSON
" expression, which fails for a real source file (a few hundred lines is tens of
" kilobytes of expression) and is invisible when it does. Reading the lines from
" a file keeps the expression tiny at any size.
" Write the buffer's lines to a file.
"
" The read direction needs this for the same reason the write direction does: a
" real source file is tens of kilobytes of JSON, and a response that size does
" not survive the client-server round trip (the caller then sees an empty
" buffer, which surfaces as "the buffer has no file").
function! SwampVimDumpBuffer(path) abort
  call writefile(getline(1, '$'), a:path)
  return json_encode({
        \ 'file': expand('%:p'),
        \ 'modified': &modified,
        \ 'lines': line('$'),
        \ 'cursor': getpos('.'),
        \ 'mode': mode(),
        \ 'filetype': &filetype,
        \ })
endfunction

function! SwampVimLoadFile(path) abort
  if !filereadable(a:path)
    throw 'not readable: ' . a:path
  endif
  silent %delete _
  execute 'silent 0read ' . fnameescape(a:path)
  " `%delete _` leaves one empty line; `0read` puts the file above it.
  if line('$') > 1 && getline(line('$')) ==# ''
    silent $delete _
  endif
  redraw!
  return json_encode({
        \ 'changed': 1,
        \ 'undo_seq': undotree().seq_cur,
        \ 'lines': line('$'),
        \ })
endfunction

function! SwampVimSetLines(lines) abort
  let old = getline(1, '$')
  let n_old = len(old)
  let n_new = len(a:lines)
  if old == a:lines
    return json_encode({'changed': 0, 'undo_seq': undotree().seq_cur})
  endif
  if n_new == 0
    silent %delete _
    call setline(1, [''])
  else
    let keep = min([n_old, n_new])
    if keep > 0
      call setline(1, a:lines[0:keep-1])
    endif
    if n_new > n_old
      call append(n_old, a:lines[keep:])
    elseif n_old > n_new
      silent execute (n_new + 1) . ',' . n_old . 'delete _'
    endif
  endif
  redraw!
  return json_encode({
        \ 'changed': 1,
        \ 'undo_seq': undotree().seq_cur,
        \ 'lines': line('$'),
        \ })
endfunction

function! SwampVimAnnotate(line, col, text) abort
  try
    if empty(prop_type_get('swampAgent'))
      call prop_type_add('swampAgent', {'highlight': 'Search'})
    endif
    if empty(prop_type_get('swampAgentMark'))
      call prop_type_add('swampAgentMark', {'highlight': 'Search'})
    endif
    call prop_clear(1, line('$'), {'type': 'swampAgent'})
    call prop_clear(1, line('$'), {'type': 'swampAgentMark'})
    if a:line > 0
      if a:col > 0
        call prop_add(a:line, a:col, {'type': 'swampAgentMark', 'length': 1})
      endif
      if a:text != ''
        call prop_add(a:line, 0, {
              \ 'type': 'swampAgent',
              \ 'text': a:text,
              \ 'text_align': 'after',
              \ })
      endif
    endif
    redraw!
    return json_encode({'ok': 1})
  catch
    return json_encode({'ok': 0, 'error': v:exception})
  endtry
endfunction

function! SwampVimClearAnnotations() abort
  if !empty(prop_type_get('swampAgent'))
    call prop_clear(1, line('$'), {'type': 'swampAgent'})
  endif
  if !empty(prop_type_get('swampAgentMark'))
    call prop_clear(1, line('$'), {'type': 'swampAgentMark'})
  endif
  redraw!
  return json_encode({'ok': 1})
endfunction

function! SwampVimSelect(l1, c1, l2, c2) abort
  call setpos("'<", [0, a:l1, a:c1, 0])
  call setpos("'>", [0, a:l2, a:c2, 0])
  normal! gv
  redraw!
  return SwampVimRead('selection')
endfunction

function! SwampVimDiagnostics() abort
  return json_encode({
        \ 'quickfix': getqflist(),
        \ 'location': getloclist(0),
        \ })
endfunction

function! SwampVimUndo(seq) abort
  if a:seq > 0
    execute 'undo ' . a:seq
  else
    undo
  endif
  redraw!
  return SwampVimStatus()
endfunction
