import MarkdownIt from 'markdown-it'
import MarkdownItKatex from 'markdown-it-katex'
import MarkdownItAnchor from 'markdown-it-anchor'
import hljs from 'highlight.js'
import 'highlight.js/styles/default.css'

import { newCell, newCellID, newNotebook } from '../state-prototypes'

import {
  moveCell, scrollToCellIfNeeded,
  addExternalDependency,
  getSelectedCellId,
  getCellBelowSelectedId,
  newStateWithSelectedCellPropertySet,
  newStateWithSelectedCellPropsAssigned,
  newStateWithRowOverflowSet,
} from './cell-reducer-utils'

const MD = MarkdownIt({
  html: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(lang, str).value;
      } catch (__) { console.warn('syntax highlighting not active') }
    }

    return ''; // use external default escaping
  },
})
MD.use(MarkdownItKatex).use(MarkdownItAnchor)

const initialVariables = new Set(Object.keys(window)) // gives all global variables
initialVariables.add('__core-js_shared__')
initialVariables.add('Mousetrap')

const evalStatuses = {}
evalStatuses.SUCCESS = 'success'
evalStatuses.ERROR = 'error'


const cellReducer = (state = newNotebook(), action) => {
  let nextState
  switch (action.type) {
    case 'INSERT_CELL': {
      const cells = state.cells.slice()
      const index = cells.findIndex(c => c.id === getSelectedCellId(state))
      const direction = (action.direction === 'above') ? 0 : 1
      const nextCell = newCell(newCellID(state.cells), 'javascript')
      cells.splice(index + direction, 0, nextCell)
      nextState = Object.assign({}, state, { cells })
      return nextState
    }
    case 'ADD_CELL': {
      nextState = Object.assign({}, state)
      const cells = nextState.cells.slice()
      const nextCell = newCell(newCellID(nextState.cells), action.cellType)
      nextState = Object.assign({}, nextState, { cells: [...cells, nextCell] })
      return nextState
    }

    case 'SELECT_CELL': {
      const cells = state.cells.slice()
      cells.forEach((c) => { c.selected = false })  // eslint-disable-line
      const index = cells.findIndex(c => c.id === action.id)
      const thisCell = cells[index]
      thisCell.selected = true
      if (action.scrollToCell) { scrollToCellIfNeeded(thisCell.id) }
      nextState = Object.assign({}, state, { cells })
      return nextState
    }

    case 'CELL_UP':
      scrollToCellIfNeeded(getSelectedCellId(state))
      return Object.assign(
        {}, state,
        { cells: moveCell(state.cells, getSelectedCellId(state), 'up') },
      )

    case 'CELL_DOWN':
      scrollToCellIfNeeded(getCellBelowSelectedId(state))
      return Object.assign(
        {}, state,
        { cells: moveCell(state.cells, getSelectedCellId(state), 'down') },
      )

    case 'UPDATE_INPUT_CONTENT':
      return newStateWithSelectedCellPropertySet(state, 'content', action.content)

    case 'CHANGE_ELEMENT_TYPE':
      return newStateWithSelectedCellPropertySet(state, 'elementType', action.elementType)

    case 'CHANGE_DOM_ELEMENT_ID':
      return newStateWithSelectedCellPropertySet(state, 'domElementID', action.elemID)

    case 'CHANGE_CELL_TYPE': {
      // create a newCell of the given type to get the defaults that
      // will need to be updated for the new cell type
      const { rowSettings } = newCell(-1, action.cellType)
      return newStateWithSelectedCellPropsAssigned(
        state,
        {
          cellType: action.cellType,
          value: undefined,
          rendered: false,
          rowSettings,
        },
      )
    }

    case 'SET_CELL_ROW_COLLAPSE_STATE': {
      let { cellId } = action
      if (cellId === undefined) { cellId = getSelectedCellId(state) }
      return newStateWithRowOverflowSet(
        state,
        cellId,
        action.rowType,
        action.viewMode,
        action.rowOverflow,
      )
    }

    case 'MARK_CELL_NOT_RENDERED':
      return newStateWithSelectedCellPropertySet(
        state,
        'rendered', false,
      )

    case 'EVALUATE_CELL': {
      const newState = Object.assign({}, state)
      let { userDefinedVariables } = newState
      const cells = newState.cells.slice()
      let { cellId } = action
      if (cellId === undefined) { cellId = getSelectedCellId(state) }
      const index = cells.findIndex(c => c.id === cellId)
      const thisCell = cells[index]
      const history = [...newState.history]
      const externalDependencies = [...newState.externalDependencies]

      if (thisCell.cellType === 'javascript') {
        // add to newState.history
        history.push({
          cellID: thisCell.id,
          lastRan: new Date(),
          content: thisCell.content,
        })

        thisCell.value = undefined

        let output
        const code = thisCell.content

        try {
          output = window.eval(code)  // eslint-disable-line
          thisCell.evalStatus = evalStatuses.SUCCESS
        } catch (e) {
          output = e
          thisCell.evalStatus = evalStatuses.ERROR
        }
        thisCell.rendered = true
        if (output !== undefined) { thisCell.value = output }

        newState.executionNumber += 1
        thisCell.executionStatus = `${newState.executionNumber}`
      } else if (thisCell.cellType === 'markdown') {
        // one line, huh.
        thisCell.value = MD.render(thisCell.content)
        thisCell.rendered = true
        thisCell.evalStatus = evalStatuses.SUCCESS
      } else if (thisCell.cellType === 'external dependencies') {
        const dependencies = thisCell.content.split('\n').filter(d => d.trim().slice(0, 2) !== '//')
        const newValues = dependencies
          .filter(d => !externalDependencies.includes(d))
          .map(addExternalDependency)

        newValues.forEach((d) => {
          if (!externalDependencies.includes(d.src)) {
            externalDependencies.push(d.src)
          }
        })
        thisCell.evalStatus = newValues.map(d => d.status).includes('error') ? evalStatuses.ERROR : evalStatuses.SUCCESS
        thisCell.value = new Array(...[...thisCell.value || [], ...newValues])
        thisCell.rendered = true
        // add to newState.history
        if (newValues.length) {
          history.push({
            cellID: thisCell.id,
            lastRan: new Date(),
            content: `// added external dependencies:\n${newValues.map(s => `// ${s.src}`).join('\n')}`,
          })
        }
        newState.executionNumber += 1
        thisCell.executionStatus = `${newState.executionNumber}`
      } else if (thisCell.cellType === 'css') {
        thisCell.rendered = true
        thisCell.value = thisCell.content
      } else {
        thisCell.rendered = false
      }

      // ok. Now let's see if there are any new declared variables or libs
      userDefinedVariables = {}
      Object.keys(window)
        .filter(g => !initialVariables.has(g))
        .forEach((g) => { userDefinedVariables[g] = window[g] })
      nextState = Object.assign(
        {}, newState,
        { cells },
        { userDefinedVariables },
        { history },
        { externalDependencies },
      )
      return nextState
    }
    case 'DELETE_CELL': {
      const selectedId = getSelectedCellId(state)
      const cells = state.cells.slice()
      if (!cells.length) return state
      const index = cells.findIndex(c => c.id === selectedId)
      const thisCell = state.cells[index]
      if (thisCell.selected) {
        let nextIndex = 0
        if (cells.length > 1) {
          if (index === cells.length - 1) nextIndex = cells.length - 2
          else nextIndex = index + 1
          cells[nextIndex].selected = true
        }
      }
      nextState = Object.assign({}, state, {
        cells: cells.filter(cell => cell.id !== selectedId),
      })
      return nextState
    }


    default:
      return state
  }
}

export default cellReducer
