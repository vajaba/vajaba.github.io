const CACHE_POW = 7;
const CACHE_SIZE = 1 << CACHE_POW;
const CACHE_MASK = CACHE_SIZE - 1;

var cscaleStep;

// GL Setup ----------------------------------

const gl = (new OffscreenCanvas(1, 1)).getContext('webgl2');

gl.enable(gl.RASTERIZER_DISCARD);

var prgMap = new Map();

var sg = {};

sg.inputParams = function(prefx, prefy, len) {
    let res = '';
    for (let i = 0; i < ((len + 3) >> 2); ++i) {
        res += `in ivec4 ${prefx + 'c' + i};\nin ivec4 ${prefy + 'c' + i};\n`
    }
    return res;
}

sg.fromClamped = function(varname, len) {
    let res = '';
    let cstr = 'xyzw';
    for (let i = 0; i < len; ++i) {
        let cvar = `${varname + 'c' + (i >> 2)}.${cstr[i & 3]}`;
        if (i == len - 1) {
            res += `if (${varname}s = ${cvar} < 0) {\n`
            res += `${varname}[${i * 2}] = uint(-${cvar} - 1) & 65535u;\n`
            res += `${varname}[${i * 2 + 1}] = uint(-${cvar} - 1) >> 16u;\n} else {\n`;
        }
        res += `${varname}[${i * 2}] = uint(${cvar}) & 65535u;\n`
        res += `${varname}[${i * 2 + 1}] = uint(${cvar}) >> 16u;\n`;
        if (i == len - 1) {
            res += '}\n';
        }
    }
    return res;
}

sg.copyVec = function(vfrom, vto, len) {
    let res = `${vto}s = ${vfrom}s;\n`;
    for (let i = 0; i < len; ++i) {
        res += `${vto}[${i}] = ${vfrom}[${i}];\n`;
    }
    return res;
}

sg.prod = function(a, b, r, len) {
    let res = `${r}s = ${a}s != ${b}s;\n`;
    res += `carry = (${a}[0] * ${b}[${len - 2}]) >> 16u;\n`;
    for (let i = 1; i < len - 1; ++i) {
        res += `carry += (${a}[${i}] * ${b}[${len - 2 - i}]) >> 16u;\n`;
    }
    for (let i = 0; i < len; ++i) {
        for (let j = 0; i + j < len; ++j) {
            if (i < len - 1) {
                res += `${r}[${i + 1}] ${j ? '+' : ''}= carry >> 16u;\n`;
                res += `carry &= 65535u;\n`;
            }
            res += `carry += ${a}[${i + j}] * ${b}[${len - j - 1}];\n`;
        }
        if (i < len - 1) {
            res += `${r}[${i}] ${i ? '+' : ''}= carry & 65535u;\ncarry >>= 16u;\n`;
        } else {
            res += `${r}[${i}] += carry;\n`;
        }
    }
    return res;
}

sg.sum = function(a, b, r, len) {
    let res = '';
    for (let i = 0; i < len - 1; ++i) {
        res += `carry ${i ? '+' : ''}= ${a}[${i}] + ${b}[${i}];\n`;
        res += `${r}[${i}] = carry & 65535u;\n`;
        res += `carry >>= 16u;\n`;
    }
    res += `${r}[${len - 1}] = carry + ${a}[${len - 1}] + ${b}[${len - 1}];\n`;
    return res;
}
       
sg.diff = function(a, b, r, len) {
    let res = '';
    for (let i = 0; i < len - 1; ++i) {
        res += `carry ${i ? '+' : ''}= ${a}[${i}] - ${b}[${i}];\n`;
        res += `${r}[${i}] = carry & 65535u;\n`;
        res += `carry = uint(int(carry) >> 16);\n`;
    }
    res += `${r}[${len - 1}] = carry + ${a}[${len - 1}] - ${b}[${len - 1}];\n`;
    return res;
}

sg.less = function(a, b, len) {
    if (len == 1) {
        return `${a}[0] < ${b}[0]`;
    } else {
        return `(${a}[${len - 1}] < ${b}[${len - 1}]) || ((${a}[${len - 1}] == ${b}[${len - 1}]) && (${sg.less(a, b, len - 1)}))`;
    }
}

sg.sigsum = function(a, b, r, len) {
    return `if (${a}s == ${b}s) {\n${sg.sum(a, b, r, len)}${r}s = ${a}s;\n} else if (${sg.less(a, b, len)}) {\n${r}s = ${b}s;\n${sg.diff(b, a, r, len)}} else {\n${r}s = ${a}s;\n${sg.diff(a, b, r, len)}}\n`;
}

sg.check = function(x, len) {
    return `if (${x}[${len - 1}] >= 4u) {return;}\n`;
}

sg.genVS = function(len) {
    return `#version 300 es

${sg.inputParams('x0', 'y0', len)}
    
    flat out uint iter;
    
    uniform uint maxIter;

void main() {
    uint x0[${len * 2}];
    uint y0[${len * 2}];
    uint x[${len * 2}];
    uint y[${len * 2}];
    uint xt[${len * 2}];
    uint xsq[${len * 2}];
    uint ysq[${len * 2}];
    uint xy[${len * 2}];
    bool x0s;
    bool y0s;
    bool xs;
    bool ys;
    bool xts;
    bool xsqs;
    bool ysqs;
    bool xys;
    
${sg.fromClamped('x0', len)}
${sg.fromClamped('y0', len)}

${sg.copyVec('x0', 'x', len * 2)}
${sg.copyVec('y0', 'y', len * 2)}
    uint carry;
    for (iter = 1u; iter < maxIter; ++iter) {
${sg.prod('x', 'x', 'xsq', len * 2)}
${sg.prod('x', 'y', 'xy', len * 2)}
${sg.prod('y', 'y', 'ysq', len * 2)}

${sg.sigsum('xsq', 'ysq', 'xt', len * 2)}

${sg.check('xt', len * 2)}
        ysqs = !ysqs;

${sg.sigsum('xsq', 'ysq', 'xt', len * 2)}


${sg.sigsum('xt', 'x0', 'x', len * 2)}

        xts = xys;
${sg.sum('xy', 'xy', 'xt', len * 2)}
${sg.sigsum('xt', 'y0', 'y', len * 2)}
        
    }
}
`;
}

function createShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    // if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        // throw new Error(gl.getShaderInfoLog(shader));
    // }
    return shader;
}

function createGLProgram(nlen) {
    const vShader = createShader(gl, gl.VERTEX_SHADER, sg.genVS(nlen));
    const fShader = createShader(gl, gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;\nvoid main() {}');
    prg = gl.createProgram();
    gl.attachShader(prg, vShader);
    gl.attachShader(prg, fShader);
    gl.transformFeedbackVaryings(
        prg,
        ['iter'],
        gl.SEPARATE_ATTRIBS,
    );
    gl.linkProgram(prg);
    // if (!gl.getProgramParameter(prg, gl.LINK_STATUS)) {
        // throw new Error(gl.getProgramInfoLog(prg))
    // }
    return prg;    
}

function getGLProgram(nlen) {
    if (!prgMap.has(nlen)) {
        prgMap.set(nlen, createGLProgram(nlen));
    }
    return prgMap.get(nlen);    
}

function setGLAttributes(prg, xArr, yArr, nvlen) {
    let xBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, xBuf);
    gl.bufferData(gl.ARRAY_BUFFER, xArr, gl.STATIC_DRAW);
    for (let i = 0; i < nvlen; ++i) {
        let xLoc = gl.getAttribLocation(prg, `x0c${i}`);
        gl.enableVertexAttribArray(xLoc);
        gl.vertexAttribIPointer(xLoc, 4, gl.INT, 16 * nvlen, i * 16);
    }
    let yBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, yBuf);
    gl.bufferData(gl.ARRAY_BUFFER, yArr, gl.STATIC_DRAW);
    for (let i = 0; i < nvlen; ++i) {
        let yLoc = gl.getAttribLocation(prg, `y0c${i}`);
        gl.enableVertexAttribArray(yLoc);
        gl.vertexAttribIPointer(yLoc, 4, gl.INT, 16 * nvlen, i * 16);
    }
}

// GL Setup ----------------------------------

function distToPix(dist) {
    return Number(dist / ((cscaleStep & 1) ? 1448n : 2048n));
}

function pixToDist(pix) {
    return BigInt(pix) * ((cscaleStep & 1) ? 1448n : 2048n);
}

function getOrder(x0, y0, maxIter) {
    let it = 0;
    let x = 0n;
    let y = 0n;
    let nsc = BigInt((cscaleStep >> 1) + 19);
    for (; it < maxIter; ++it) {
        let xsq = (x*x) >> nsc;
        let ysq = (y*y) >> nsc;
        let dxy = (x*y) >> (nsc - 1n);
        if (xsq + ysq > (4n << nsc)) break;
        x = xsq - ysq + x0;
        y = dxy + y0;
    }
    return it;
}

function getOrderFast(x0, y0, maxIter) {
    let it = 0;
    let x = 0;
    let y = 0;
    for (; it < maxIter; ++it) {
        if (x*x + y*y > 4) break;
        let xt = x*x - y*y + x0;
        y = 2*x*y + y0;
        x = xt;
    }
    return it;
}

function calcFloat(ix, iy, cxmin, cymin, maxIter) {
    let data = new Uint32Array(CACHE_SIZE * CACHE_SIZE);
    let cscale = ((cscaleStep & 1) ? 724 : 1024) * Math.pow(2, -(cscaleStep >> 1)-18);
    let fmul = Math.pow(2, -(cscaleStep >> 1) - 19);
    let cxminf = Number(cxmin) * fmul;
    let cyminf = Number(cymin) * fmul;
    for (let dx = 0; dx < CACHE_SIZE; ++dx) {
        for (let dy = 0; dy < CACHE_SIZE; ++dy) {
            data[(dy << CACHE_POW) + dx] = getOrderFast(cxminf + (ix + dx) * cscale, cyminf + (iy + dy) * cscale, maxIter);
        }
    }
    return data;
}

function calcBigInt(ix, iy, cxmin, cymin, maxIter) {
    let data = new Uint32Array(CACHE_SIZE * CACHE_SIZE);
    for (let dx = 0; dx < CACHE_SIZE; ++dx) {
        for (let dy = 0; dy < CACHE_SIZE; ++dy) {
            data[(dy << CACHE_POW) + dx] = getOrder(cxmin + pixToDist(ix + dx), cymin + pixToDist(iy + dy), maxIter);
        }
    }    
    return data;
}

function calcGL(ix, iy, cxmin, cymin, maxIter) {
    const nscale = (cscaleStep >> 1) + 19;
    const nlen = (nscale + 47) >> 5;
    const nlsh = BigInt(32 * nlen - 16 - nscale);
    // const nlen = 1;
    // const nrsh = BigInt(nscale - 16);

    const prg = getGLProgram(nlen);
    
    let nvlen = (nlen + 3) >> 2;
    
    let xArr = new Int32Array(CACHE_SIZE * CACHE_SIZE * nvlen * 4);
    let yArr = new Int32Array(CACHE_SIZE * CACHE_SIZE * nvlen * 4);
    for (let i = 0; i < CACHE_SIZE; ++i) {
        let xn = cxmin + pixToDist(ix + i);
        let yn = cymin + pixToDist(iy + i);
        let xns, yns;
        if (xns = xn < 0) { xn = -xn; }
        if (yns = yn < 0) { yn = -yn; }
        xn <<= nlsh;
        yn <<= nlsh;
        // xn >>= nrsh;
        // yn >>= nrsh;
        
        for (let arri = 0; arri < nlen; ++arri) {
            let xiv = Number(BigInt.asUintN(32, xn));
            let yiv = Number(BigInt.asUintN(32, yn));
            if (arri == nlen - 1 && xns) xiv = -xiv-1;
            if (arri == nlen - 1 && yns) yiv = -yiv-1;
            for (let j = 0; j < CACHE_SIZE; ++j) {
                xArr[((j << CACHE_POW) + i) * nvlen * 4 + arri] = xiv;
                yArr[((i << CACHE_POW) + j) * nvlen * 4 + arri] = yiv;
            }
            xn >>= 32n;
            yn >>= 32n;
        }
    }
    
    const glVao = gl.createVertexArray();
    gl.bindVertexArray(glVao);    
    
    setGLAttributes(prg, xArr, yArr, nvlen);
    
    const tf = gl.createTransformFeedback();
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);

    let mloc = gl.getUniformLocation(prg, 'maxIter')

    const rBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, rBuf);
    gl.bufferData(gl.ARRAY_BUFFER, CACHE_SIZE * CACHE_SIZE * 4, gl.STATIC_DRAW);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, rBuf);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    
    gl.useProgram(prg);
    gl.uniform1ui(mloc, maxIter);
    gl.bindVertexArray(glVao);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, CACHE_SIZE * CACHE_SIZE);
    gl.endTransformFeedback();
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    
    let data = new Uint32Array(CACHE_SIZE * CACHE_SIZE);

    gl.bindBuffer(gl.ARRAY_BUFFER, rBuf);
    gl.getBufferSubData(gl.ARRAY_BUFFER, 0, data);

    return data;
}

function calcData(icxi, icyi, cxmin, cymin, maxIter, data) {
    let ix = icxi << CACHE_POW;
    let iy = icyi << CACHE_POW;
    if ((cscaleStep > 80) && gl) {
        return calcGL(ix, iy, cxmin, cymin, maxIter);
    } else {
        return calcFloat(ix, iy, cxmin, cymin, maxIter);
    }
}

self.onmessage = function (msg) {
    cscaleStep = msg.data.cscaleStep;
    msg.data['data'] = calcData(msg.data.icxi, msg.data.icyi, msg.data.cxmin, msg.data.cymin, msg.data.maxIter).buffer;
    self.postMessage(msg.data, [msg.data.data]);
};