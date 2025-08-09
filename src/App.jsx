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
        .replace(/\/\//g, 'Math.floor')
        .replace(/\*\*/g, '**');

      // Handle power operator
      jsExpression = jsExpression.replace(/(\d+|\w+)\s*\*\*\s*(\d+|\w+)/g, 'Math.pow($1, $2)');

      // Handle string literals
      jsExpression = jsExpression.replace(/'([^']*)'/g, '"$1"');

      // Create function with variables and helpers in scope
      const allVariables = { ...variables, ...helperFunctions };
      const func = new Function(...Object.keys(allVariables), `return ${jsExpression};`);
      return func(...Object.values(allVariables));
    } catch (err) {
      throw new Error(`Error evaluating: ${expression} - ${err.message}`);
    }
  };

  const parseMultiLineStructure = (lines, startIndex) => {
    let structure = '';
    let braceCount = 0;
    let bracketCount = 0;
    let i = startIndex;
    
    while (i < lines.length) {
      const line = lines[i].trimmed;
      structure += line;
      
      // Count braces and brackets
      for (const char of line) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (char === '[') bracketCount++;
        if (char === ']') bracketCount--;
      }
      
      // If we've closed all braces and brackets, we're done
      if (braceCount === 0 && bracketCount === 0) {
        break;
      }
      
      i++;
      if (i < lines.length) {
        structure += ' '; // Add space between lines
      }
    }
    
    return { structure, endIndex: i };
  };

  // Function to parse list comprehensions
  const parseListComprehension = (expression, variables) => {
    // Match pattern: [expr for var in iterable] or [expr for var in iterable if condition]
    const listCompMatch = expression.match(/\[(.*?)\s+for\s+(\w+)\s+in\s+(.*?)(?:\s+if\s+(.*?))?\]/);
    
    if (!listCompMatch) {
      return null;
    }
    
    const [, expr, iterVar, iterableExpr, condition] = listCompMatch;
    
    try {
      const iterableValue = safeEval(iterableExpr, variables);
      if (!Array.isArray(iterableValue) && typeof iterableValue !== 'string') {
        throw new Error(`'${typeof iterableValue}' object is not iterable`);
      }
      
      const result = [];
      for (const item of iterableValue) {
        const tempVars = { ...variables, [iterVar]: item };
        
        // Check condition if it exists
        if (condition) {
          const conditionResult = safeEval(condition, tempVars);
          if (!conditionResult) continue;
        }
        
        // Evaluate expression
        const value = safeEval(expr, tempVars);
        result.push(value);
      }
      
      return result;
    } catch (err) {
      throw new Error(`List comprehension error: ${err.message}`);
    }
  };

  // Function to handle function definitions and calls
  const handleFunctionCall = (funcName, args, variables, output) => {
    const func = variables[funcName];
    
    if (!func || typeof func !== 'object' || !func.isFunction) {
      throw new Error(`'${funcName}' is not defined or not a function`);
    }
    
    // Create new scope for function execution
    const functionScope = { ...func.closure };
    
    // Bind parameters to arguments
    for (let i = 0; i < func.params.length; i++) {
      if (i < args.length) {
        functionScope[func.params[i]] = args[i];
      }
    }
    
    // Execute function body
    let returnValue = null;
    const functionOutput = [];
    
    for (const bodyLine of func.body) {
      try {
        // Handle return statements
        if (bodyLine.trimmed.startsWith('return ')) {
          const returnExpr = bodyLine.trimmed.slice(7).trim();
          returnValue = safeEval(returnExpr, functionScope);
          break;
        }
        
        // Handle other statements in function
        const result = processLine(bodyLine, functionScope, functionOutput, lines);
        Object.assign(functionScope, result.variables);
        functionOutput.push(...result.output);
      } catch (err) {
        throw new Error(`Error in function '${funcName}': ${err.message}`);
      }
    }
    
    // Add function output to main output
    output.push(...functionOutput);
    
    return returnValue;
  };

  // Helper function to process a single line
  const processLine = (lineData, currentVars, currentOutput, lines) => {
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
      if (trimmed.includes('=') && !['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%='].some(op => trimmed.includes(op))) {
        const parts = trimmed.split('=');
        const varName = parts[0].trim();
        const expression = parts.slice(1).join('=').trim();
        
        let value;
        
        // Check for list comprehension
        if (expression.match(/\[.*?\s+for\s+\w+\s+in\s+.*?\]/)) {
          try {
            value = parseListComprehension(expression, vars);
          } catch (err) {
            throw new Error(`List comprehension error: ${err.message}`);
          }
        }
        // Check for function calls that return values
        else if (expression.match(/\w+\(.*\)/)) {
          const funcMatch = expression.match(/(\w+)\((.*)\)/);
          if (funcMatch) {
            const [, funcName, argsStr] = funcMatch;
            
            if (vars[funcName] && typeof vars[funcName] === 'object' && vars[funcName].isFunction) {
              // Parse arguments properly
              let args = [];
              if (argsStr.trim()) {
                // Split by commas but handle nested structures
                const argParts = [];
                let current = '';
                let depth = 0;
                let inString = false;
                let stringChar = '';
                
                for (let i = 0; i < argsStr.length; i++) {
                  const char = argsStr[i];
                  
                  if (!inString && (char === '"' || char === "'")) {
                    inString = true;
                    stringChar = char;
                  } else if (inString && char === stringChar) {
                    inString = false;
                  } else if (!inString) {
                    if (char === '(' || char === '[' || char === '{') depth++;
                    else if (char === ')' || char === ']' || char === '}') depth--;
                    else if (char === ',' && depth === 0) {
                      argParts.push(current.trim());
                      current = '';
                      continue;
                    }
                  }
                  current += char;
                }
                if (current.trim()) argParts.push(current.trim());
                
                args = argParts.map(arg => safeEval(arg, vars));
              }
              
              try {
                value = handleFunctionCall(funcName, args, vars, out);
              } catch (err) {
                throw new Error(`Function call error: ${err.message}`);
              }
            } else {
              // Regular expression evaluation (built-in functions, etc.)
              try {
                value = safeEval(expression, vars);
              } catch (err) {
                // If it's not a function call or evaluation, treat as string
                value = expression;
              }
            }
          }
        }
        else if ((expression.startsWith('{') || expression.startsWith('[')) && 
                   (!expression.endsWith('}') && !expression.endsWith(']'))) {
            // Find the complete structure across multiple lines
            const { structure } = parseMultiLineStructure(lines, originalIndex);
            const fullExpression = structure.slice(structure.indexOf(expression.charAt(0)));
            
            try {
              // Parse dictionary
              if (fullExpression.startsWith('{')) {
                value = JSON.parse(fullExpression.replace(/'/g, '"').replace(/(\w+):/g, '"$1":'));
              }
              // Parse list
              else if (fullExpression.startsWith('[')) {
                value = JSON.parse(fullExpression.replace(/'/g, '"'));
              }
            } catch {
              value = fullExpression;
            }
          }
        // Handle single-line structures
        else if (expression.startsWith('[') && expression.endsWith(']')) {
          try {
            // Try to parse as JSON first
            const jsonStr = expression.replace(/'/g, '"');
            value = JSON.parse(jsonStr);
          } catch {
            // If JSON parsing fails, evaluate as expression
            try {
              value = safeEval(expression, vars);
            } catch {
              value = expression;
            }
          }
        } 
        else if (expression.startsWith('{') && expression.endsWith('}')) {
          try {
            // Convert Python dict syntax to JSON
            const jsonStr = expression
              .replace(/'/g, '"')
              .replace(/(\w+):/g, '"$1":')
              .replace(/True/g, 'true')
              .replace(/False/g, 'false')
              .replace(/None/g, 'null');
            value = JSON.parse(jsonStr);
          } catch {
            try {
              value = safeEval(expression, vars);
            } catch {
              value = expression;
            }
          }
        }
        // Regular expression evaluation
        else {
          try {
            value = safeEval(expression, vars);
          } catch (err) {
            // If evaluation fails, check if it's a simple string or number
            if (!isNaN(expression)) {
              value = parseFloat(expression);
            } else if (expression === 'True') {
              value = true;
            } else if (expression === 'False') {
              value = false;
            } else if (expression === 'None') {
              value = null;
            } else if (expression.startsWith('"') && expression.endsWith('"')) {
              value = expression.slice(1, -1);
            } else if (expression.startsWith("'") && expression.endsWith("'")) {
              value = expression.slice(1, -1);
            } else {
              value = expression;
            }
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
            rightValue = safeEval(rightExpr.trim(), vars);
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
            const value = safeEval(args, vars);
            list.push(value);
            operationResult = `Appended ${helperFunctions.__repr(value)} to ${listName}`;
          } 
          else if (operation === 'extend') {
            const iterable = safeEval(args, vars);
            if (Array.isArray(iterable)) {
              list.push(...iterable);
              operationResult = `Extended ${listName} with ${helperFunctions.__repr(iterable)}`;
            } else {
              throw new Error(`'${typeof iterable}' object is not iterable`);
            }
          }
          else if (operation === 'remove') {
            const value = safeEval(args, vars);
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
              const index = parseInt(safeEval(args, vars));
              resultValue = list.splice(index, 1)[0];
              operationResult = `Popped element at index ${index} (${helperFunctions.__repr(resultValue)}) from ${listName}`;
            }
          }
          else if (operation === 'insert') {
            const [indexStr, valueStr] = args.split(',').map(s => s.trim());
            const index = parseInt(safeEval(indexStr, vars));
            const value = safeEval(valueStr, vars);
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
      // Handle print statements with better parsing
      else if (trimmed.startsWith('print(')) {
        const printMatch = trimmed.match(/print\((.*)\)/);
        if (printMatch) {
          const args = printMatch[1];
          
          // Handle multiple print arguments
          const printArgs = [];
          if (args.trim()) {
            // Split arguments properly
            const argParts = [];
            let current = '';
            let depth = 0;
            let inString = false;
            let stringChar = '';
            
            for (let i = 0; i < args.length; i++) {
              const char = args[i];
              
              if (!inString && (char === '"' || char === "'")) {
                inString = true;
                stringChar = char;
              } else if (inString && char === stringChar) {
                inString = false;
              } else if (!inString) {
                if (char === '(' || char === '[' || char === '{') depth++;
                else if (char === ')' || char === ']' || char === '}') depth--;
                else if (char === ',' && depth === 0) {
                  argParts.push(current.trim());
                  current = '';
                  continue;
                }
              }
              current += char;
            }
            if (current.trim()) argParts.push(current.trim());
            
            for (const arg of argParts) {
              try {
                const value = safeEval(arg, vars);
                printArgs.push(value);
              } catch (err) {
                // If it's a string literal, remove quotes
                if ((arg.startsWith('"') && arg.endsWith('"')) || 
                    (arg.startsWith("'") && arg.endsWith("'"))) {
                  printArgs.push(arg.slice(1, -1));
                } else {
                  printArgs.push(arg);
                }
              }
            }
          }
          
          const outputText = printArgs.map(arg => {
            if (Array.isArray(arg)) {
              return `[${arg.map(item => helperFunctions.__repr(item)).join(', ')}]`;
            } else {
              return helperFunctions.__repr(arg);
            }
          }).join(' ');
          
          out.push(outputText);
          
          lineSteps.push({
            line: originalIndex,
            action: 'print',
            value: printArgs,
            outputText: outputText,
            variables: JSON.parse(JSON.stringify(vars)),
            output: [...out]
          });
        }
      }
      // Handle function definitions
      else if (trimmed.startsWith('def ')) {
        const funcMatch = trimmed.match(/def\s+(\w+)\((.*?)\):/);
        if (funcMatch) {
          const [, funcName, params] = funcMatch;
          
          // This will be handled by the main parsing loop
          const func = {
            name: funcName,
            params: params.split(',').map(p => p.trim()).filter(p => p),
            body: [], // Will be filled by main loop
            closure: JSON.parse(JSON.stringify(vars)),
            isFunction: true
          };
          
          vars[funcName] = func;
          
          lineSteps.push({
            line: originalIndex,
            action: 'function_definition',
            functionName: funcName,
            params: func.params,
            bodyLines: 0, // Will be updated by main loop
            variables: JSON.parse(JSON.stringify(vars)),
            output: [...out]
          });
        }
      }
      // Handle function calls (standalone, not part of assignment)
      else if (trimmed.match(/^\w+\(.*\)$/) && !trimmed.startsWith('print(')) {
        const funcMatch = trimmed.match(/^(\w+)\((.*)\)$/);
        if (funcMatch) {
          const [, funcName, argsStr] = funcMatch;
          const func = vars[funcName];
          
          if (func && typeof func === 'object' && func.isFunction) {
            // Parse arguments
            let args = [];
            if (argsStr.trim()) {
              const argParts = [];
              let current = '';
              let depth = 0;
              let inString = false;
              let stringChar = '';
              
              for (let i = 0; i < argsStr.length; i++) {
                const char = argsStr[i];
                
                if (!inString && (char === '"' || char === "'")) {
                  inString = true;
                  stringChar = char;
                } else if (inString && char === stringChar) {
                  inString = false;
                } else if (!inString) {
                  if (char === '(' || char === '[' || char === '{') depth++;
                  else if (char === ')' || char === ']' || char === '}') depth--;
                  else if (char === ',' && depth === 0) {
                    argParts.push(current.trim());
                    current = '';
                    continue;
                  }
                }
                current += char;
              }
              if (current.trim()) argParts.push(current.trim());
              
              args = argParts.map(arg => safeEval(arg.trim(), vars));
            }
            
            try {
              const result = handleFunctionCall(funcName, args, vars, out);
              
              lineSteps.push({
                line: originalIndex,
                action: 'function_call',
                functionName: funcName,
                args: args,
                returnValue: result,
                variables: JSON.parse(JSON.stringify(vars)),
                output: [...out]
              });
            } catch (err) {
              throw new Error(`Function call error: ${err.message}`);
            }
          } else {
            throw new Error(`'${funcName}' is not defined`);
          }
        }
      }
      // Handle for loops
      else if (trimmed.startsWith('for ')) {
        const forMatch = trimmed.match(/for\s+(\w+)\s+in\s+(.*?):/);
        if (forMatch) {
          const [, iterVar, iterableExpr] = forMatch;
          let iterableValue;
          
          try {
            iterableValue = safeEval(iterableExpr, vars);
          } catch (err) {
            iterableValue = [];
          }
          
          if (!Array.isArray(iterableValue) && typeof iterableValue !== 'string') {
            throw new Error(`'${typeof iterableValue}' object is not iterable`);
          }
          
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
          conditionResult = safeEval(condition, vars);
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
          conditionResult = safeEval(condition, vars);
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
            iterableValue = safeEval(iterableExpr, variables);
          } catch (err) {
            iterableValue = [];
          }
          
          if (!Array.isArray(iterableValue) && typeof iterableValue !== 'string') {
            throw new Error(`'${typeof iterableValue}' object is not iterable`);
          }
          
          // Find the loop body
          const loopBody = [];
          let j = i + 1;
          while (j < lines.length && (lines[j].trimmed === '' || lines[j].indent > indent)) {
            if (lines[j].trimmed !== '') {
              loopBody.push(lines[j]);
            }
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
              const result = processLine(bodyLine, variables, output, lines);
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
      
      // Handle function definitions (skip the body in main loop)
      if (trimmed.startsWith('def ')) {
        const funcMatch = trimmed.match(/def\s+(\w+)\((.*?)\):/);
        if (funcMatch) {
          const [, funcName, params] = funcMatch;
          
          // Find function body
          const functionBody = [];
          let j = i + 1;
          while (j < lines.length && (lines[j].trimmed === '' || lines[j].indent > indent)) {
            if (lines[j].trimmed !== '') {
              functionBody.push(lines[j]);
            }
            j++;
          }
          
          // Create a function object
          const func = {
            name: funcName,
            params: params.split(',').map(p => p.trim()).filter(p => p),
            body: functionBody,
            closure: JSON.parse(JSON.stringify(variables)),
            isFunction: true
          };
          
          variables[funcName] = func;
          
          steps.push({
            line: originalIndex,
            action: 'function_definition',
            functionName: funcName,
            params: func.params,
            bodyLines: functionBody.length,
            variables: JSON.parse(JSON.stringify(variables)),
            output: [...output]
          });
          
          // Skip function body
          i = j - 1;
          continue;
        }
      }
      
      // Process regular lines
      const result = processLine(lines[i], variables, output, lines);
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
      const isFunction = typeof value === 'object' && value !== null && value.isFunction;
      
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
            ) : typeof value === 'object' && value !== null && !isFunction ? (
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
        
        {currentStep.functionName && (
          <div className="detail-item">
            <strong>Function:</strong> <span className="variable-name">{currentStep.functionName}</span>
            {currentStep.args && (
              <>
                <br />
                <strong>Arguments:</strong> [{currentStep.args.map(arg => helperFunctions.__repr(arg)).join(', ')}]
              </>
            )}
            {currentStep.returnValue !== undefined && (
              <>
                <br />
                <strong>Return Value:</strong> <span className="value-display">{helperFunctions.__repr(currentStep.returnValue)}</span>
              </>
            )}
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

const examplePythonCode = `# Python Code Visualizer Demo - Fixed Version
numbers = [1, 2, 3]
print("Initial array:", numbers)

# Multi-line dictionary
student = {
    "name": "Alice",
    "age": 21,
    "courses": ["Math", "Physics"]
}
print("Student:", student)

# Add elements to list
numbers.append(4)
numbers.append(5)
print("After adding 4 and 5:", numbers)

# Function definition and call
def greet(name):
    message = "Hello, " + name + "!"
    return message

# Function call with assignment
greeting = greet("Bob")
print("Greeting:", greeting)

# Direct function call (should show return value)
print("Direct call:", greet("Alice"))

# List comprehension
squares = [x**2 for x in range(5)]
print("Squares:", squares)

# List comprehension with condition
evens = [x for x in range(10) if x % 2 == 0]
print("Even numbers:", evens)

# Calculate sum with loop
total = 0
for num in numbers:
    total += num
    print("Current sum:", total)

print("Final total:", total)`;

const App = () => {
  return (
    <div className="app">
      <h1>Python Code Visualizer - Enhanced</h1>
      <p>Step through Python code execution with support for functions, dictionaries, and list comprehensions</p>
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
          min-height: 250px;
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
          max-height: 200px;
          overflow-y: auto;
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
          min-width: 80px;
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
          font-weight: bold;
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
          flex-wrap: wrap;
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
        
        .error-text {
          color: #f44336;
          font-weight: bold;
        }
        
        /* Scrollbar styling */
        .variables-container::-webkit-scrollbar,
        .code-container::-webkit-scrollbar,
        .output-container::-webkit-scrollbar,
        .array-elements::-webkit-scrollbar,
        .dict-entries::-webkit-scrollbar {
          width: 6px;
        }
        
        .variables-container::-webkit-scrollbar-track,
        .code-container::-webkit-scrollbar-track,
        .output-container::-webkit-scrollbar-track,
        .array-elements::-webkit-scrollbar-track,
        .dict-entries::-webkit-scrollbar-track {
          background: #f1f1f1;
          border-radius: 3px;
        }
        
        .variables-container::-webkit-scrollbar-thumb,
        .code-container::-webkit-scrollbar-thumb,
        .output-container::-webkit-scrollbar-thumb,
        .array-elements::-webkit-scrollbar-thumb,
        .dict-entries::-webkit-scrollbar-thumb {
          background: #888;
          border-radius: 3px;
        }
        
        .variables-container::-webkit-scrollbar-thumb:hover,
        .code-container::-webkit-scrollbar-thumb:hover,
        .output-container::-webkit-scrollbar-thumb:hover,
        .array-elements::-webkit-scrollbar-thumb:hover,
        .dict-entries::-webkit-scrollbar-thumb:hover {
          background: #555;
        }
      `}</style>
    </div>
  );
};

export default App;