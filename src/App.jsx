import React, { useState, useEffect, useRef } from 'react';

const PythonCodeVisualizer = ({ initialCode }) => {
  const [code, setCode] = useState(initialCode);
  const [executionState, setExecutionState] = useState({
    step: 0,
    variables: {},
    currentLine: -1,
    isRunning: false,
    executionSteps: [],
    output: [],
    callStack: [],
    breakpoints: [],
  });
  const [speed, setSpeed] = useState(1000);
  const [error, setError] = useState(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const executionInterval = useRef(null);
  const codeContainerRef = useRef(null);

  // Helper functions for Python-like evaluation
  const helperFunctions = {
    __print: (...args) => {
      const output = args.map(arg => {
        if (typeof arg === 'object') {
          if (Array.isArray(arg)) {
            return `[${arg.map(item => helperFunctions.__repr(item)).join(', ')}]`;
          } else if (arg === null) {
            return 'None';
          } else {
            return JSON.stringify(arg);
          }
        }
        return String(arg);
      }).join(' ');
      return output;
    },
    __repr: (value) => {
      if (value === null) return 'None';
      if (value === true) return 'True';
      if (value === false) return 'False';
      if (typeof value === 'string') return `'${value}'`;
      if (typeof value === 'number') return String(value);
      if (Array.isArray(value)) return `[${value.map(helperFunctions.__repr).join(', ')}]`;
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    },
    __range: (...args) => {
      if (args.length === 1) return Array.from({length: args[0]}, (_, i) => i);
      if (args.length === 2) return Array.from({length: args[1] - args[0]}, (_, i) => i + args[0]);
      if (args.length === 3) {
        const [start, stop, step] = args;
        const result = [];
        for (let i = start; step > 0 ? i < stop : i > stop; i += step) {
          result.push(i);
        }
        return result;
      }
      return [];
    },
    __len: (obj) => {
      if (Array.isArray(obj)) return obj.length;
      if (typeof obj === 'string') return obj.length;
      if (typeof obj === 'object' && obj !== null) return Object.keys(obj).length;
      throw new Error(`object of type '${typeof obj}' has no len()`);
    }
  };

  const safeEval = (expression, variables, context = {}) => {
    try {
      // Handle Python-specific syntax
      let jsExpression = expression
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null')
        .replace(/\bprint\(/g, '__print(')
        .replace(/\brange\(/g, '__range(')
        .replace(/\blen\(/g, '__len(')
        .replace(/\bnot\s+/g, '!')
        .replace(/\band\b/g, '&&')
        .replace(/\bor\b/g, '||')
        .replace(/\/\//g, 'Math.floor($1/$2)')
        .replace(/\*\*/g, 'Math.pow($1,$2)');

      // Handle string literals
      jsExpression = jsExpression.replace(/'([^']*)'/g, '"$1"');

      // Create function with variables and helpers in scope
      const allVariables = { ...variables, ...helperFunctions };
      const func = new Function(...Object.keys(allVariables), `return ${jsExpression};`);
      return func(...Object.values(allVariables));
    } catch (err) {
      // Try to handle simple assignments
      if (expression.includes('=') && !['==', '!=', '<=', '>=', '+='].some(op => expression.includes(op))) {
        const parts = expression.split('=');
        if (parts.length === 2) {
          const rightSide = parts[1].trim();
          if (rightSide in variables) return variables[rightSide];
          if (!isNaN(rightSide)) return parseFloat(rightSide);
          if (rightSide.startsWith('"') && rightSide.endsWith('"')) return rightSide.slice(1, -1);
          if (rightSide.startsWith("'") && rightSide.endsWith("'")) return rightSide.slice(1, -1);
          if (rightSide === 'True') return true;
          if (rightSide === 'False') return false;
          if (rightSide === 'None') return null;
        }
      }
      throw new Error(`Error evaluating: ${expression} - ${err.message}`);
    }
  };

  // Parse Python code into executable steps
  const parseCode = (codeString) => {
    const lines = codeString.split('\n').map((line, i) => ({ 
      content: line, 
      originalIndex: i,
      trimmed: line.trim(),
      indent: line.length - line.trimStart().length
    }));
    
    const steps = [];
    let variables = {};
    let output = [];

    const addOutput = (text) => {
      output.push(text);
    };

    // Helper function to process a block of code (for loops, if blocks, etc.)
    const processBlock = (startIndex, baseIndent) => {
      const blockSteps = [];
      let i = startIndex;
      
      while (i < lines.length && lines[i].indent > baseIndent) {
        const result = processLine(lines[i], variables, output);
        blockSteps.push(...result.steps);
        variables = result.variables;
        output = result.output;
        i++;
      }
      
      return { steps: blockSteps, nextIndex: i };
    };

    // Helper function to process a single line
    const processLine = (lineData, currentVars, currentOutput) => {
      const { content: line, originalIndex, trimmed, indent } = lineData;
      const lineSteps = [];
      let vars = { ...currentVars };
      let out = [...currentOutput];

      // Skip empty lines and comments
      if (trimmed === '' || trimmed.startsWith('#')) {
        return { steps: lineSteps, variables: vars, output: out };
      }

      try {
        // Handle variable assignment
        if (trimmed.includes('=') && !['==', '!=', '<=', '>=', '+='].some(op => trimmed.includes(op))) {
          const parts = trimmed.split('=');
          const varName = parts[0].trim();
          const expression = parts.slice(1).join('=').trim();
          
          let value;
          if (expression.startsWith('[') && expression.endsWith(']')) {
            // Handle list literals
            try {
              value = JSON.parse(expression.replace(/'/g, '"'));
            } catch {
              value = expression;
            }
          } else if (expression.startsWith('{') && expression.endsWith('}')) {
            // Handle dict literals
            try {
              value = JSON.parse(expression.replace(/'/g, '"'));
            } catch {
              value = expression;
            }
          } else {
            // Evaluate other expressions
            try {
              value = safeEval(expression, vars, { addOutput: (text) => out.push(text) });
            } catch (err) {
              value = expression;
            }
          }
          
          const oldValue = vars[varName];
          vars[varName] = value;
          
          lineSteps.push({
            line: originalIndex,
            action: oldValue !== undefined ? 'reassign' : 'assign',
            variable: varName,
            value: value,
            oldValue: oldValue,
            expression: expression,
            variables: JSON.parse(JSON.stringify(vars)),
            output: [...out]
          });
        }
        // Handle augmented assignments (like +=, -=)
        else if (trimmed.match(/[\w]+\s*[\+\-\*\/%]=\s*.+/)) {
          const match = trimmed.match(/(\w+)\s*([\+\-\*\/%])=(.+)/);
          if (match) {
            const [_, varName, operator, rightExpr] = match;
            const oldValue = vars[varName];
            let rightValue;
            
            try {
              rightValue = safeEval(rightExpr.trim(), vars, { addOutput: (text) => out.push(text) });
            } catch (err) {
              rightValue = rightExpr.trim();
            }
            
            let newValue;
            if (operator === '+') {
              if (typeof oldValue === 'string' || typeof rightValue === 'string') {
                newValue = String(oldValue) + String(rightValue);
              } else {
                newValue = oldValue + rightValue;
              }
            } else if (operator === '-') {
              newValue = oldValue - rightValue;
            } else if (operator === '*') {
              newValue = oldValue * rightValue;
            } else if (operator === '/') {
              newValue = oldValue / rightValue;
            } else if (operator === '%') {
              newValue = oldValue % rightValue;
            }
            
            vars[varName] = newValue;
            
            lineSteps.push({
              line: originalIndex,
              action: 'augmented_assign',
              variable: varName,
              operator: operator,
              value: newValue,
              oldValue: oldValue,
              rightValue: rightValue,
              variables: JSON.parse(JSON.stringify(vars)),
              output: [...out]
            });
          }
        }
        // Handle list operations
        else if (trimmed.match(/\w+\.(append|extend|remove|pop|insert|index|count)\(/)) {
          const match = trimmed.match(/(\w+)\.(\w+)\((.*)\)/);
          if (match) {
            const [_, listName, operation, args] = match;
            const list = vars[listName];
            
            if (!Array.isArray(list)) {
              throw new Error(`'${typeof list}' object has no attribute '${operation}'`);
            }
            
            const oldList = [...list];
            let operationResult = '';
            let resultValue = null;
            
            if (operation === 'append') {
              const value = safeEval(args, vars, { addOutput: (text) => out.push(text) });
              list.push(value);
              operationResult = `Appended ${helperFunctions.__repr(value)} to ${listName}`;
            } 
            else if (operation === 'extend') {
              const iterable = safeEval(args, vars, { addOutput: (text) => out.push(text) });
              if (Array.isArray(iterable)) {
                list.push(...iterable);
                operationResult = `Extended ${listName} with ${helperFunctions.__repr(iterable)}`;
              } else {
                throw new Error(`'${typeof iterable}' object is not iterable`);
              }
            }
            else if (operation === 'remove') {
              const value = safeEval(args, vars, { addOutput: (text) => out.push(text) });
              const index = list.indexOf(value);
              if (index > -1) {
                list.splice(index, 1);
                operationResult = `Removed first occurrence of ${helperFunctions.__repr(value)} from ${listName}`;
              } else {
                throw new Error(`Value ${helperFunctions.__repr(value)} not found in list`);
              }
            }
            else if (operation === 'pop') {
              if (args.trim() === '') {
                resultValue = list.pop();
                operationResult = `Popped last element (${helperFunctions.__repr(resultValue)}) from ${listName}`;
              } else {
                const index = parseInt(safeEval(args, vars, { addOutput: (text) => out.push(text) }));
                resultValue = list.splice(index, 1)[0];
                operationResult = `Popped element at index ${index} (${helperFunctions.__repr(resultValue)}) from ${listName}`;
              }
            }
            else if (operation === 'insert') {
              const [indexStr, valueStr] = args.split(',').map(s => s.trim());
              const index = parseInt(safeEval(indexStr, vars, { addOutput: (text) => out.push(text) }));
              const value = safeEval(valueStr, vars, { addOutput: (text) => out.push(text) });
              list.splice(index, 0, value);
              operationResult = `Inserted ${helperFunctions.__repr(value)} at index ${index} in ${listName}`;
            }
            
            vars[listName] = list;
            
            lineSteps.push({
              line: originalIndex,
              action: 'list_operation',
              list: listName,
              operation: operation,
              value: list,
              oldValue: oldList,
              operationResult: operationResult,
              resultValue: resultValue,
              variables: JSON.parse(JSON.stringify(vars)),
              output: [...out]
            });
          }
        }
        // Handle dictionary operations
        else if (trimmed.match(/\w+\.(get|keys|values|items|update|pop)\(/)) {
          const match = trimmed.match(/(\w+)\.(\w+)\((.*)\)/);
          if (match) {
            const [_, dictName, operation, args] = match;
            const dict = vars[dictName];
            
            if (typeof dict !== 'object' || dict === null || Array.isArray(dict)) {
              throw new Error(`'${typeof dict}' object has no attribute '${operation}'`);
            }
            
            const oldDict = {...dict};
            let operationResult = '';
            let resultValue = null;
            
            if (operation === 'get') {
              const [keyStr, defaultValue] = args.split(',').map(s => s.trim());
              const key = safeEval(keyStr, vars, { addOutput: (text) => out.push(text) });
              resultValue = key in dict ? dict[key] : (defaultValue ? safeEval(defaultValue, vars, { addOutput: (text) => out.push(text) }) : null);
              operationResult = `Got value for key ${helperFunctions.__repr(key)}: ${helperFunctions.__repr(resultValue)}`;
            }
            else if (operation === 'keys') {
              resultValue = Object.keys(dict);
              operationResult = `Retrieved keys from ${dictName}`;
            }
            else if (operation === 'values') {
              resultValue = Object.values(dict);
              operationResult = `Retrieved values from ${dictName}`;
            }
            else if (operation === 'items') {
              resultValue = Object.entries(dict);
              operationResult = `Retrieved items from ${dictName}`;
            }
            else if (operation === 'update') {
              const newItems = safeEval(args, vars, { addOutput: (text) => out.push(text) });
              Object.assign(dict, newItems);
              operationResult = `Updated ${dictName} with new items`;
            }
            else if (operation === 'pop') {
              const [keyStr, defaultValue] = args.split(',').map(s => s.trim());
              const key = safeEval(keyStr, vars, { addOutput: (text) => out.push(text) });
              if (key in dict) {
                resultValue = dict[key];
                delete dict[key];
                operationResult = `Popped key ${helperFunctions.__repr(key)} with value ${helperFunctions.__repr(resultValue)}`;
              } else if (defaultValue) {
                resultValue = safeEval(defaultValue, vars, { addOutput: (text) => out.push(text) });
                operationResult = `Key ${helperFunctions.__repr(key)} not found, returned default value ${helperFunctions.__repr(resultValue)}`;
              } else {
                throw new Error(`KeyError: ${helperFunctions.__repr(key)}`);
              }
            }
            
            vars[dictName] = dict;
            
            lineSteps.push({
              line: originalIndex,
              action: 'dict_operation',
              dict: dictName,
              operation: operation,
              value: dict,
              oldValue: oldDict,
              operationResult: operationResult,
              resultValue: resultValue,
              variables: JSON.parse(JSON.stringify(vars)),
              output: [...out]
            });
          }
        }
        // Handle print statements
        else if (trimmed.startsWith('print(')) {
          const printMatch = trimmed.match(/print\((.*)\)/);
          if (printMatch) {
            const args = printMatch[1];
            let printValue;
            
            try {
              printValue = safeEval(args, vars, { addOutput: (text) => out.push(text) });
            } catch (err) {
              printValue = args.replace(/['"]/g, '');
            }
            
            const outputText = Array.isArray(printValue) ? 
              `[${printValue.map(item => helperFunctions.__repr(item)).join(', ')}]` : 
              helperFunctions.__repr(printValue);
            
            out.push(outputText);
            
            lineSteps.push({
              line: originalIndex,
              action: 'print',
              value: printValue,
              outputText: outputText,
              variables: JSON.parse(JSON.stringify(vars)),
              output: [...out]
            });
          }
        }
        // Handle for loops
        else if (trimmed.startsWith('for ')) {
          const forMatch = trimmed.match(/for\s+(\w+)\s+in\s+(.*?):/);
          if (forMatch) {
            const [, iterVar, iterableExpr] = forMatch;
            let iterableValue;
            
            try {
              iterableValue = safeEval(iterableExpr, vars, { addOutput: (text) => out.push(text) });
            } catch (err) {
              iterableValue = [];
            }
            
            if (!Array.isArray(iterableValue) && typeof iterableValue !== 'string') {
              throw new Error(`'${typeof iterableValue}' object is not iterable`);
            }
            
            // Push loop start step
            lineSteps.push({
              line: originalIndex,
              action: 'for_loop_start',
              iterVar: iterVar,
              iterable: iterableValue,
              variables: JSON.parse(JSON.stringify(vars)),
              output: [...out]
            });
          }
        }
        // Handle if statements
        else if (trimmed.startsWith('if ')) {
          const condition = trimmed.slice(3, -1).trim();
          let conditionResult;
          
          try {
            conditionResult = safeEval(condition, vars, { addOutput: (text) => out.push(text) });
          } catch (err) {
            conditionResult = false;
          }
          
          lineSteps.push({
            line: originalIndex,
            action: 'if_statement',
            condition: condition,
            conditionResult: Boolean(conditionResult),
            variables: JSON.parse(JSON.stringify(vars)),
            output: [...out]
          });
        }
        // Handle while loops
        else if (trimmed.startsWith('while ')) {
          const condition = trimmed.slice(6, -1).trim();
          let conditionResult;
          
          try {
            conditionResult = safeEval(condition, vars, { addOutput: (text) => out.push(text) });
          } catch (err) {
            conditionResult = false;
          }
          
          lineSteps.push({
            line: originalIndex,
            action: 'while_loop_start',
            condition: condition,
            conditionResult: Boolean(conditionResult),
            variables: JSON.parse(JSON.stringify(vars)),
            output: [...out]
          });
        }
        // Handle function definitions
        else if (trimmed.startsWith('def ')) {
          const funcMatch = trimmed.match(/def\s+(\w+)\((.*?)\):/);
          if (funcMatch) {
            const [, funcName, params] = funcMatch;
            
            // Create a function object
            const func = {
              name: funcName,
              params: params.split(',').map(p => p.trim()).filter(p => p),
              variables: JSON.parse(JSON.stringify(vars))
            };
            
            vars[funcName] = func;
            
            lineSteps.push({
              line: originalIndex,
              action: 'function_definition',
              functionName: funcName,
              variables: JSON.parse(JSON.stringify(vars)),
              output: [...out]
            });
          }
        }
        // Handle function calls
        else if (trimmed.match(/\w+\(.*\)/) && !trimmed.startsWith('print(')) {
          const funcMatch = trimmed.match(/(\w+)\((.*)\)/);
          if (funcMatch) {
            const [, funcName, args] = funcMatch;
            const func = vars[funcName];
            
            if (typeof func !== 'object' || func === null) {
              throw new Error(`'${funcName}' is not defined`);
            }
            
            const argValues = args.split(',').map(arg => safeEval(arg.trim(), vars, { addOutput: (text) => out.push(text) }));
            
            lineSteps.push({
              line: originalIndex,
              action: 'function_call',
              functionName: funcName,
              args: argValues,
              variables: JSON.parse(JSON.stringify(vars)),
              output: [...out]
            });
          }
        }
        // Other executable lines
        else if (trimmed.length > 0 && !trimmed.endsWith(':')) {
          lineSteps.push({
            line: originalIndex,
            action: 'execute',
            code: trimmed,
            variables: JSON.parse(JSON.stringify(vars)),
            output: [...out]
          });
        }
      } catch (err) {
        console.error(`Error parsing line ${originalIndex + 1}: ${line}`, err);
        lineSteps.push({
          line: originalIndex,
          action: 'error',
          error: err.message,
          variables: JSON.parse(JSON.stringify(vars)),
          output: [...out]
        });
      }

      return { steps: lineSteps, variables: vars, output: out };
    };

    // Main parsing loop with proper block handling
    for (let i = 0; i < lines.length; i++) {
      const { content: line, originalIndex, trimmed, indent } = lines[i];
      
      // Skip empty lines and comments
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      // Handle for loops
      if (trimmed.startsWith('for ')) {
        const forMatch = trimmed.match(/for\s+(\w+)\s+in\s+(.*?):/);
        if (forMatch) {
          const [, iterVar, iterableExpr] = forMatch;
          let iterableValue;
          
          try {
            iterableValue = safeEval(iterableExpr, variables, { addOutput });
          } catch (err) {
            iterableValue = [];
          }
          
          if (!Array.isArray(iterableValue) && typeof iterableValue !== 'string') {
            throw new Error(`'${typeof iterableValue}' object is not iterable`);
          }
          
          // Find the loop body (indented lines after the for statement)
          const loopBody = [];
          let j = i + 1;
          while (j < lines.length && lines[j].indent > indent) {
            loopBody.push(lines[j]);
            j++;
          }
          
          // Push loop start step
          steps.push({
            line: originalIndex,
            action: 'for_loop_start',
            iterVar: iterVar,
            iterable: iterableValue,
            loopBody: loopBody.map(l => l.originalIndex),
            variables: JSON.parse(JSON.stringify(variables)),
            output: [...output]
          });
          
          // Process each iteration
          for (let iterIndex = 0; iterIndex < iterableValue.length; iterIndex++) {
            const item = iterableValue[iterIndex];
            
            // Update the iteration variable
            variables[iterVar] = item;
            
            // Push iteration step
            steps.push({
              line: originalIndex,
              action: 'for_loop_iteration',
              iterVar: iterVar,
              currentValue: item,
              iterationIndex: iterIndex,
              totalIterations: iterableValue.length,
              variables: JSON.parse(JSON.stringify(variables)),
              output: [...output]
            });
            
            // Process loop body for this iteration
            for (const bodyLine of loopBody) {
              const result = processLine(bodyLine, variables, output);
              steps.push(...result.steps);
              variables = result.variables;
              output = result.output;
            }
          }
          
          // Push loop end step
          steps.push({
            line: originalIndex,
            action: 'for_loop_end',
            iterVar: iterVar,
            variables: JSON.parse(JSON.stringify(variables)),
            output: [...output]
          });
          
          // Skip processing the loop body again in the main loop
          i = j - 1;
          continue;
        }
      }
      
      // Handle other control structures (if, while, etc.)
      if (trimmed.endsWith(':')) {
        // Push control structure start step
        steps.push({
          line: originalIndex,
          action: 'control_structure_start',
          code: trimmed,
          variables: JSON.parse(JSON.stringify(variables)),
          output: [...output]
        });
        
        // Process the block
        const { steps: blockSteps, nextIndex } = processBlock(i + 1, indent);
        steps.push(...blockSteps);
        i = nextIndex - 1;
        
        // Push control structure end step
        steps.push({
          line: originalIndex,
          action: 'control_structure_end',
          code: trimmed,
          variables: JSON.parse(JSON.stringify(variables)),
          output: [...output]
        });
        
        continue;
      }
      
      // Process regular lines
      const result = processLine(lines[i], variables, output);
      steps.push(...result.steps);
      variables = result.variables;
      output = result.output;
    }
    
    return steps;
  };

  const resetVisualization = () => {
    setError(null);
    try {
      const steps = parseCode(code);
      setExecutionState(prev => ({
        ...prev,
        step: 0,
        variables: {},
        currentLine: steps.length > 0 ? steps[0].line : -1,
        isRunning: false,
        executionSteps: steps,
        output: [],
        callStack: [],
      }));
      if (executionInterval.current) {
        clearInterval(executionInterval.current);
        executionInterval.current = null;
      }
    } catch (err) {
      setError(`Error parsing code: ${err.message}`);
    }
  };

  const nextStep = () => {
    setExecutionState(prev => {
      if (prev.step >= prev.executionSteps.length - 1) {
        if (executionInterval.current) {
          clearInterval(executionInterval.current);
          executionInterval.current = null;
        }
        return { ...prev, isRunning: false };
      }
      const nextStep = prev.step + 1;
      const stepData = prev.executionSteps[nextStep];
      
      return {
        ...prev,
        step: nextStep,
        variables: stepData.variables || prev.variables,
        currentLine: stepData.line,
        output: stepData.output || prev.output,
      };
    });
  };

  const prevStep = () => {
    setExecutionState(prev => {
      if (prev.step <= 0) return prev;
      const prevStep = prev.step - 1;
      const stepData = prev.executionSteps[prevStep];
      
      return {
        ...prev,
        step: prevStep,
        variables: stepData.variables || prev.variables,
        currentLine: stepData.line,
        output: stepData.output || prev.output,
      };
    });
  };

  const togglePlay = () => {
    if (executionState.isRunning) {
      clearInterval(executionInterval.current);
      executionInterval.current = null;
      setExecutionState(prev => ({ ...prev, isRunning: false }));
    } else {
      if (executionState.step >= executionState.executionSteps.length - 1) {
        resetVisualization();
      }
      executionInterval.current = setInterval(nextStep, speed);
      setExecutionState(prev => ({ ...prev, isRunning: true }));
    }
  };

  const handleSpeedChange = (e) => {
    const newSpeed = parseInt(e.target.value);
    setSpeed(newSpeed);
    if (executionState.isRunning) {
      clearInterval(executionInterval.current);
      executionInterval.current = setInterval(nextStep, newSpeed);
    }
  };

  const toggleBreakpoint = (lineIndex) => {
    setExecutionState(prev => {
      const newBreakpoints = prev.breakpoints.includes(lineIndex)
        ? prev.breakpoints.filter(bp => bp !== lineIndex)
        : [...prev.breakpoints, lineIndex];
      
      return { ...prev, breakpoints: newBreakpoints };
    });
  };

  const jumpToStep = (stepIndex) => {
    setExecutionState(prev => {
      if (stepIndex < 0 || stepIndex >= prev.executionSteps.length) return prev;
      const stepData = prev.executionSteps[stepIndex];
      
      return {
        ...prev,
        step: stepIndex,
        variables: stepData.variables || prev.variables,
        currentLine: stepData.line,
        output: stepData.output || prev.output,
      };
    });
  };

  useEffect(() => {
    if (!isInitialized) {
      resetVisualization();
      setIsInitialized(true);
    }
  }, [isInitialized]);

  useEffect(() => {
    if (executionState.currentLine >= 0 && codeContainerRef.current) {
      const lineElement = codeContainerRef.current.querySelector(`.code-line[data-line="${executionState.currentLine}"]`);
      if (lineElement) {
        lineElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [executionState.currentLine]);

  const renderVariables = () => {
    return Object.entries(executionState.variables).map(([name, value]) => {
      const isFunction = typeof value === 'object' && value !== null && 'name' in value && 'params' in value && 'body' in value;
      
      return (
        <div key={name} className={`variable ${isFunction ? 'function' : ''}`}>
          <div className="variable-header">
            <span className="variable-name">{name}:</span>
            <span className="variable-type">
              {isFunction ? 'function' : Array.isArray(value) ? 'list' : typeof value}
            </span>
          </div>
          <div className="variable-content">
            {isFunction ? (
              <div className="function-visualization">
                <div className="function-signature">
                  def {value.name}({value.params.join(', ')})
                </div>
                <div className="function-body">
                  {value.body.length} lines of code
                </div>
              </div>
            ) : Array.isArray(value) ? (
              <div className="array-visualization">
                <div className="array-info">
                  List[{value.length}]
                  <span className="array-memory">@{Math.random().toString(16).slice(2, 8)}</span>
                </div>
                <div className="array-elements">
                  {value.map((item, index) => (
                    <div key={index} className="array-element">
                      <span className="array-index">[{index}]</span>
                      <span className="array-value">{helperFunctions.__repr(item)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : typeof value === 'object' && value !== null ? (
              <div className="dict-visualization">
                <div className="dict-info">
                  Dict[{Object.keys(value).length}]
                  <span className="dict-memory">@{Math.random().toString(16).slice(2, 8)}</span>
                </div>
                <div className="dict-entries">
                  {Object.entries(value).map(([key, val]) => (
                    <div key={key} className="dict-entry">
                      <span className="dict-key">{helperFunctions.__repr(key)}:</span>
                      <span className="dict-value">{helperFunctions.__repr(val)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <span className="variable-value">{helperFunctions.__repr(value)}</span>
            )}
          </div>
        </div>
      );
    });
  };

  const renderCode = () => {
    return code.split('\n').map((line, index) => (
      <div 
        key={index}
        data-line={index}
        className={`code-line 
          ${index === executionState.currentLine ? 'highlight' : ''}
          ${executionState.breakpoints.includes(index) ? 'breakpoint' : ''}
        `}
        onClick={() => toggleBreakpoint(index)}
      >
        <span className="line-number">{index + 1}</span>
        <pre className="code-content">{line}</pre>
      </div>
    ));
  };

  const renderStepDetails = () => {
    const currentStep = executionState.executionSteps[executionState.step];
    if (!currentStep) return null;

    return (
      <div className="step-details">
        <h4>Current Step Details:</h4>
        <div className="detail-item">
          <strong>Line:</strong> {currentStep.line + 1}
        </div>
        <div className="detail-item">
          <strong>Action:</strong> <span className="action-type">{currentStep.action.replace(/_/g, ' ')}</span>
        </div>
        
        {currentStep.variable && (
          <div className="detail-item">
            <strong>Variable:</strong> <span className="variable-name">{currentStep.variable}</span>
          </div>
        )}
        
        {currentStep.value !== undefined && (
          <div className="detail-item">
            <strong>Value:</strong> <span className="value-display">{helperFunctions.__repr(currentStep.value)}</span>
          </div>
        )}
        
        {currentStep.oldValue !== undefined && (
          <div className="detail-item">
            <strong>Previous Value:</strong> <span className="value-display">{helperFunctions.__repr(currentStep.oldValue)}</span>
          </div>
        )}
        
        {currentStep.operationResult && (
          <div className="detail-item operation-result">
            <strong>Operation:</strong> {currentStep.operationResult}
          </div>
        )}
        
        {currentStep.expression && (
          <div className="detail-item">
            <strong>Expression:</strong> <code>{currentStep.expression}</code>
          </div>
        )}
        
        {currentStep.condition && (
          <div className="detail-item">
            <strong>Condition:</strong> <code>{currentStep.condition}</code> → 
            <span className={currentStep.conditionResult ? 'condition-true' : 'condition-false'}>
              {currentStep.conditionResult ? ' True' : ' False'}
            </span>
          </div>
        )}
        
        {currentStep.error && (
          <div className="detail-item error-message">
            <strong>Error:</strong> <span className="error-text">{currentStep.error}</span>
          </div>
        )}
      </div>
    );
  };

  const renderCallStack = () => {
    if (executionState.callStack.length === 0) return null;
    
    return (
      <div className="call-stack">
        <h4>Call Stack:</h4>
        <div className="stack-frames">
          {executionState.callStack.map((frame, index) => (
            <div key={index} className="stack-frame">
              <div className="frame-name">{frame.functionName}</div>
              <div className="frame-location">Line {frame.lineNumber + 1}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="python-visualizer">
      {error && (
        <div className="error-message">
          <h3>Error</h3>
          <pre>{error}</pre>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      
      <div className="controls">
        <button onClick={resetVisualization}>Reset</button>
        <button onClick={prevStep} disabled={executionState.isRunning || executionState.step <= 0}>
          Previous Step
        </button>
        <button onClick={nextStep} disabled={executionState.isRunning || executionState.step >= executionState.executionSteps.length - 1}>
          Next Step
        </button>
        <button onClick={togglePlay}>
          {executionState.isRunning ? 'Pause' : 'Play'}
        </button>
        <div className="speed-control">
          <label>Speed:</label>
          <input 
            type="range" 
            min="100" 
            max="3000" 
            step="100"
            value={speed} 
            onChange={handleSpeedChange}
          />
          <span>{speed}ms</span>
        </div>
        <div className="step-navigation">
          <input
            type="number"
            min="1"
            max={executionState.executionSteps.length}
            value={executionState.step + 1}
            onChange={(e) => jumpToStep(parseInt(e.target.value) - 1)}
          />
          <span> / {executionState.executionSteps.length}</span>
        </div>
      </div>

      <div className="editor-section">
        <h3>Python Code Editor</h3>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="code-editor"
          rows={10}
          placeholder="Enter your Python code here..."
        />
      </div>
      
      <div className="visualization-container">
        <div className="code-display" ref={codeContainerRef}>
          <h3>Code Execution</h3>
          <div className="code-container">
            {renderCode()}
          </div>
        </div>
        
        <div className="variables-display">
          <h3>Variables & Memory</h3>
          <div className="variables-container">
            {renderVariables()}
          </div>
        </div>

        <div className="output-display">
          <h3>Output</h3>
          <div className="output-container">
            {executionState.output.map((line, index) => (
              <div key={index} className="output-line">{line}</div>
            ))}
          </div>
        </div>
      </div>

      <div className="execution-info">
        <div className="execution-progress">
          <p>
            <strong>Step:</strong> {executionState.step + 1} of {executionState.executionSteps.length}
          </p>
          <div className="progress-bar">
            <div 
              className="progress-fill" 
              style={{ 
                width: `${((executionState.step + 1) / executionState.executionSteps.length) * 100}%` 
              }}
            ></div>
          </div>
        </div>
        
        {renderStepDetails()}
        {renderCallStack()}
      </div>
    </div>
  );
};

const examplePythonCode = `# Python Code Visualizer Demo
numbers = [1, 2, 3]
print("Initial array:", numbers)

# Add elements
numbers.append(4)
numbers.append(5)
print("After adding 4 and 5:", numbers)

# Calculate sum
total = 0
for num in numbers:
    total += num
    print("Current sum:", total)

# Dictionary example
student = {
    "name": "Alice",
    "age": 21,
    "courses": ["Math", "Physics"]
}
print("Student:", student)

# Function example
def greet(name):
    return "Hello, " + name

message = greet("Bob")
print(message)

# List comprehension
squares = [x**2 for x in range(5)]
print("Squares:", squares)`;

const App = () => {
  return (
    <div className="app">
      <h1>Python Code Visualizer</h1>
      <p>Step through Python code execution and visualize variables in real-time</p>
      <PythonCodeVisualizer initialCode={examplePythonCode} />
      
      <style jsx="true" global="true">{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        
        body {
          font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
          background: #f5f5f5;
          color: #333;
          line-height: 1.6;
        }
        
        .python-visualizer {
          max-width: 1400px;
          margin: 0 auto;
          padding: 20px;
          background: white;
          border-radius: 12px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
        }
        
        .app {
          padding: 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
        }
        
        .app h1 {
          text-align: center;
          color: white;
          margin-bottom: 10px;
          font-size: 2.5em;
          text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
        
        .app p {
          text-align: center;
          color: rgba(255,255,255,0.9);
          margin-bottom: 30px;
          font-size: 1.1em;
        }
        
        .controls {
          display: flex;
          gap: 10px;
          margin-bottom: 20px;
          align-items: center;
          background: #f0f0f0;
          padding: 15px;
          border-radius: 8px;
          flex-wrap: wrap;
        }
        
        .speed-control {
          margin-left: auto;
          display: flex;
          align-items: center;
          gap: 10px;
          color: #555;
        }
        
        .speed-control input {
          width: 120px;
        }
        
        .step-navigation {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        
        .step-navigation input {
          width: 60px;
          padding: 5px;
          border: 1px solid #ddd;
          border-radius: 4px;
          text-align: center;
        }
        
        .editor-section {
          margin-bottom: 20px;
          background: #f8f8f8;
          padding: 20px;
          border-radius: 8px;
        }
        
        .editor-section h3 {
          color: #444;
          margin-bottom: 15px;
          font-size: 1.2em;
        }
        
        .code-editor {
          width: 100%;
          padding: 15px;
          border: 1px solid #ddd;
          border-radius: 8px;
          background: #1e1e1e;
          color: #d4d4d4;
          font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
          font-size: 14px;
          line-height: 1.4;
          resize: vertical;
          min-height: 200px;
        }
        
        .visualization-container {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 20px;
          margin-bottom: 20px;
        }
        
        @media (max-width: 1200px) {
          .visualization-container {
            grid-template-columns: 1fr;
          }
        }
        
        .code-display, .variables-display, .output-display {
          background: white;
          border-radius: 8px;
          padding: 15px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
          border: 1px solid #eee;
        }
        
        .code-display h3, .variables-display h3, .output-display h3 {
          color: #444;
          margin-bottom: 15px;
          font-size: 1.2em;
        }
        
        .code-container {
          background: #1e1e1e;
          color: #d4d4d4;
          padding: 10px;
          border-radius: 6px;
          max-height: 400px;
          overflow-y: auto;
          font-size: 14px;
          border: 1px solid #333;
        }
        
        .code-line {
          display: flex;
          margin: 2px 0;
          padding: 4px 8px;
          border-radius: 4px;
          transition: all 0.2s ease;
          cursor: pointer;
        }
        
        .code-line:hover {
          background: rgba(255, 255, 255, 0.1);
        }
        
        .code-line.highlight {
          background: rgba(255, 193, 7, 0.3);
          border-left: 3px solid #ffc107;
          animation: pulse 0.5s ease-in-out;
        }
        
        .code-line.breakpoint::before {
          content: '';
          display: inline-block;
          width: 12px;
          height: 12px;
          background: #ff5252;
          border-radius: 50%;
          margin-right: 10px;
        }
        
        @keyframes pulse {
          0% { transform: scale(1); }
          50% { transform: scale(1.02); }
          100% { transform: scale(1); }
        }
        
        .line-number {
          color: #858585;
          margin-right: 15px;
          width: 30px;
          text-align: right;
          font-weight: bold;
          user-select: none;
        }
        
        .code-content {
          margin: 0;
          white-space: pre-wrap;
          flex: 1;
        }
        
        .variables-container {
          display: flex;
          flex-direction: column;
          gap: 10px;
          max-height: 400px;
          overflow-y: auto;
          padding-right: 5px;
        }
        
        .variable {
          background: white;
          border-radius: 6px;
          padding: 12px;
          border-left: 4px solid #4caf50;
          transition: all 0.2s ease;
          box-shadow: 0 2px 5px rgba(0, 0, 0, 0.05);
        }
        
        .variable.function {
          border-left-color: #2196f3;
        }
        
        .variable:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        
        .variable-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        
        .variable-name {
          font-weight: bold;
          color: #333;
          font-size: 15px;
        }
        
        .variable-type {
          background: #e0e0e0;
          color: #555;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 11px;
          text-transform: capitalize;
        }
        
        .variable-content {
          color: #333;
        }
        
        .variable-value {
          font-family: 'SF Mono', monospace;
          background: #f5f5f5;
          padding: 4px 8px;
          border-radius: 4px;
          display: inline-block;
          font-size: 14px;
        }
        
        .array-visualization, .dict-visualization, .function-visualization {
          margin-top: 8px;
        }
        
        .array-info, .dict-info {
          color: #555;
          font-weight: bold;
          margin-bottom: 8px;
          display: flex;
          justify-content: space-between;
          font-size: 14px;
        }
        
        .array-memory, .dict-memory {
          color: #9e9e9e;
          font-size: 12px;
          font-family: 'SF Mono', monospace;
        }
        
        .array-elements, .dict-entries {
          background: #f5f5f5;
          border-radius: 6px;
          padding: 8px;
          font-size: 14px;
        }
        
        .array-element {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 4px 0;
          padding: 4px 8px;
          background: white;
          border-radius: 4px;
          border: 1px solid #e0e0e0;
        }
        
        .array-index {
          background: #2196f3;
          color: white;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: bold;
          min-width: 30px;
          text-align: center;
        }
        
        .array-value {
          font-family: 'SF Mono', monospace;
          color: #333;
        }
        
        .dict-entry {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 4px 0;
          padding: 4px 8px;
          background: white;
          border-radius: 4px;
          border: 1px solid #e0e0e0;
        }
        
        .dict-key {
          font-weight: bold;
          color: #2196f3;
        }
        
        .dict-value {
          font-family: 'SF Mono', monospace;
          color: #333;
        }
        
        .function-visualization {
          background: #e3f2fd;
          padding: 10px;
          border-radius: 6px;
          font-size: 14px;
        }
        
        .function-signature {
          font-family: 'SF Mono', monospace;
          color: #0d47a1;
          margin-bottom: 5px;
        }
        
        .function-body {
          color: #555;
          font-size: 13px;
        }
        
        .output-container {
          background: #1e1e1e;
          border-radius: 6px;
          padding: 15px;
          max-height: 400px;
          overflow-y: auto;
          font-family: 'SF Mono', monospace;
          border: 1px solid #333;
        }
        
        .output-line {
          color: #4caf50;
          margin: 4px 0;
          padding: 4px 8px;
          border-left: 3px solid #4caf50;
          background: rgba(76, 175, 80, 0.1);
          border-radius: 4px;
          font-size: 14px;
          white-space: pre-wrap;
        }
        
        .execution-info {
          background: white;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
          border: 1px solid #eee;
        }
        
        .execution-progress p {
          color: #555;
          margin-bottom: 10px;
          font-weight: bold;
        }
        
        .progress-bar {
          background: #e0e0e0;
          border-radius: 10px;
          height: 8px;
          overflow: hidden;
          margin-bottom: 20px;
        }
        
        .progress-fill {
          background: linear-gradient(90deg, #4caf50, #8bc34a);
          height: 100%;
          transition: width 0.3s ease;
          border-radius: 10px;
        }
        
        .step-details {
          background: #f5f5f5;
          padding: 15px;
          border-radius: 8px;
          margin-top: 15px;
          font-size: 14px;
        }
        
        .step-details h4 {
          color: #333;
          margin-bottom: 10px;
          font-size: 1.1em;
        }
        
        .detail-item {
          margin: 8px 0;
          color: #333;
          display: flex;
          align-items: flex-start;
          gap: 10px;
        }
        
        .detail-item strong {
          color: #555;
          min-width: 120px;
          font-weight: 500;
        }
        
        .action-type {
          text-transform: capitalize;
          background: #e3f2fd;
          color: #1976d2;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 13px;
        }
        
        .variable-name {
          font-family: 'SF Mono', monospace;
          color: #9c27b0;
        }
        
        .value-display {
          font-family: 'SF Mono', monospace;
          background: #f5f5f5;
          padding: 2px 6px;
          border-radius: 4px;
        }
        
        .operation-result {
          background: rgba(76, 175, 80, 0.1);
          padding: 8px 12px;
          border-radius: 6px;
          border-left: 4px solid #4caf50;
        }
        
        .condition-true {
          color: #4caf50;
          font-weight: bold;
        }
        
        .condition-false {
          color: #f44336;
          font-weight: bold;
        }
        
        .error-message {
          background: #ffebee;
          padding: 15px;
          border-radius: 8px;
          margin-bottom: 20px;
          border-left: 4px solid #f44336;
        }
        
        .error-message h3 {
          color: #d32f2f;
          margin-bottom: 10px;
        }
        
        .error-message pre {
          color: #b71c1c;
          white-space: pre-wrap;
          margin-bottom: 10px;
        }
        
        .error-message button {
          background: #f44336;
          color: white;
        }
        
        .call-stack {
          margin-top: 20px;
          background: #f5f5f5;
          padding: 15px;
          border-radius: 8px;
        }
        
        .call-stack h4 {
          color: #333;
          margin-bottom: 10px;
          font-size: 1.1em;
        }
        
        .stack-frames {
          display: flex;
          flex-direction: column-reverse;
          gap: 8px;
        }
        
        .stack-frame {
          background: white;
          padding: 10px;
          border-radius: 6px;
          border-left: 3px solid #2196f3;
          font-size: 14px;
        }
        
        .frame-name {
          font-weight: bold;
          color: #333;
        }
        
        .frame-location {
          color: #666;
          font-size: 13px;
        }
        
        button {
          padding: 8px 16px;
          background: #4caf50;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s ease;
          font-size: 14px;
          display: flex;
          align-items: center;
          gap: 5px;
        }
        
        button:hover {
          background: #388e3c;
          transform: translateY(-1px);
        }
        
        button:disabled {
          background: #bdbdbd;
          cursor: not-allowed;
          transform: none;
        }
        
        button:active:not(:disabled) {
          transform: translateY(1px);
        }
        
        input, textarea {
          border: 1px solid #ddd;
          border-radius: 4px;
          padding: 8px 12px;
          font-family: inherit;
          transition: border 0.2s;
        }
        
        input:focus, textarea:focus {
          outline: none;
          border-color: #4caf50;
        }
      `}</style>
    </div>
  );
};

export default App;