import {
    assignFilteredGlobalDescriptorsFromPropertyDescriptorMap,
    Connector,
    createBlueConnector,
    createRedConnector,
    DistortionCallback,
    getFilteredGlobalOwnKeys,
    Getter,
    Instrumentation,
    linkIntrinsics,
    PropertyKeys,
    toSafeWeakMap,
    VirtualEnvironment,
} from '@locker/near-membrane-base';

import {
    getCachedGlobalObjectReferences,
    filterWindowKeys,
    removeWindowDescriptors,
    unforgeablePoisonedWindowKeys,
} from './window';

export interface BrowserEnvironmentOptions {
    distortionCallback?: DistortionCallback;
    endowments?: PropertyDescriptorMap;
    globalObjectShape?: object;
    keepAlive?: boolean;
    instrumentation?: Instrumentation;
}

const IFRAME_SANDBOX_ATTRIBUTE_VALUE = 'allow-same-origin allow-scripts';

const ObjectCtor = Object;
const TypeErrorCtor = TypeError;
const WeakMapCtor = WeakMap;
const { prototype: DocumentProto } = Document;
const { prototype: NodeProto } = Node;
const { remove: ElementProtoRemove, setAttribute: ElementProtoSetAttribute } = Element.prototype;
const { appendChild: NodeProtoAppendChild } = NodeProto;
const { assign: ObjectAssign } = ObjectCtor;
// eslint-disable-next-line @typescript-eslint/naming-convention
const { __lookupGetter__: ObjectProtoLookupGetter } = ObjectCtor.prototype as any;
const { apply: ReflectApply } = Reflect;
const {
    close: DocumentProtoClose,
    createElement: DocumentProtoCreateElement,
    open: DocumentProtoOpen,
} = DocumentProto;
const DocumentProtoBodyGetter: Getter = ReflectApply(ObjectProtoLookupGetter, DocumentProto, [
    'body',
])!;
const HTMLElementProtoStyleGetter: Getter = ReflectApply(
    ObjectProtoLookupGetter,
    HTMLElement.prototype,
    ['style']
)!;
const HTMLIFrameElementProtoContentWindowGetter: Getter = ReflectApply(
    ObjectProtoLookupGetter,
    HTMLIFrameElement.prototype,
    ['contentWindow']
)!;
const NodeProtoLastChildGetter: Getter = ReflectApply(ObjectProtoLookupGetter, NodeProto, [
    'lastChild',
])!;

const blueDocumentToBlueCreateHooksCallbackMap = toSafeWeakMap(
    new WeakMapCtor<Document, Connector>()
);

let defaultGlobalOwnKeys: PropertyKeys | null = null;

function createDetachableIframe(doc: Document): HTMLIFrameElement {
    const iframe: HTMLIFrameElement = ReflectApply(DocumentProtoCreateElement, doc, ['iframe']);
    // It is impossible to test whether the NodeProtoLastChildGetter branch is
    // reached in a normal Karma test environment.
    const parent: Element =
        ReflectApply(DocumentProtoBodyGetter, doc, []) ??
        /* istanbul ignore next */ ReflectApply(NodeProtoLastChildGetter, doc, []);
    const style: CSSStyleDeclaration = ReflectApply(HTMLElementProtoStyleGetter, iframe, []);
    style.display = 'none';
    ReflectApply(ElementProtoSetAttribute, iframe, ['sandbox', IFRAME_SANDBOX_ATTRIBUTE_VALUE]);
    ReflectApply(NodeProtoAppendChild, parent, [iframe]);
    return iframe;
}

function createIframeVirtualEnvironment(
    globalObject: WindowProxy & typeof globalThis,
    options?: BrowserEnvironmentOptions
): VirtualEnvironment {
    if (typeof globalObject !== 'object' || globalObject === null) {
        throw new TypeErrorCtor('Missing global object virtualization target.');
    }
    const blueRefs = getCachedGlobalObjectReferences(globalObject);
    if (typeof blueRefs !== 'object' || blueRefs === null) {
        throw new TypeErrorCtor('Invalid virtualization target.');
    }
    const {
        distortionCallback,
        endowments,
        globalObjectShape,
        instrumentation,
        keepAlive = false,
        // eslint-disable-next-line prefer-object-spread
    } = ObjectAssign({ __proto__: null }, options);
    const iframe = createDetachableIframe(blueRefs.document);
    const redWindow: Window & typeof globalThis = ReflectApply(
        HTMLIFrameElementProtoContentWindowGetter,
        iframe,
        []
    )!;
    const shouldUseDefaultGlobalOwnKeys =
        typeof globalObjectShape !== 'object' || globalObjectShape === null;
    if (shouldUseDefaultGlobalOwnKeys && defaultGlobalOwnKeys === null) {
        defaultGlobalOwnKeys = filterWindowKeys(getFilteredGlobalOwnKeys(redWindow));
    }
    let blueConnector = blueDocumentToBlueCreateHooksCallbackMap.get(blueRefs.document) as
        | Connector
        | undefined;
    if (blueConnector === undefined) {
        blueConnector = createBlueConnector(globalObject);
        blueDocumentToBlueCreateHooksCallbackMap.set(blueRefs.document, blueConnector);
    }
    const env = new VirtualEnvironment({
        blueConnector,
        distortionCallback,
        instrumentation,
        redConnector: createRedConnector(redWindow.eval),
    });
    linkIntrinsics(env, globalObject);
    // window
    // window.document
    // In browsers globalThis is === window.
    if (typeof globalThis === 'undefined') {
        // Support for globalThis was added in Chrome 71.
        // However, environments like Android emulators are running Chrome 69.
        env.link('window', 'document');
    } else {
        // document is === window.document.
        env.link('document');
    }
    // window.__proto__ (aka Window.prototype)
    // window.__proto__.__proto__ (aka WindowProperties.prototype)
    // window.__proto__.__proto__.__proto__ (aka EventTarget.prototype)
    env.link('__proto__', '__proto__', '__proto__');
    env.remapProto(blueRefs.document, blueRefs.DocumentProto);
    env.lazyRemapProperties(
        blueRefs.window,
        shouldUseDefaultGlobalOwnKeys
            ? (defaultGlobalOwnKeys as PropertyKeys)
            : filterWindowKeys(getFilteredGlobalOwnKeys(globalObjectShape)),
        // Chromium based browsers have a bug that nulls the result of `window`
        // getters in detached iframes when the property descriptor of `window.window`
        // is retrieved.
        // https://bugs.chromium.org/p/chromium/issues/detail?id=1305302
        keepAlive ? undefined : unforgeablePoisonedWindowKeys
    );
    if (endowments) {
        const filteredEndowments: PropertyDescriptorMap = {};
        assignFilteredGlobalDescriptorsFromPropertyDescriptorMap(filteredEndowments, endowments);
        removeWindowDescriptors(filteredEndowments);
        env.remapProperties(blueRefs.window, filteredEndowments);
    }
    // We intentionally skip remapping Window.prototype because there is nothing
    // in it that needs to be remapped.
    env.lazyRemapProperties(blueRefs.EventTargetProto, blueRefs.EventTargetProtoOwnKeys);
    // We don't remap `blueRefs.WindowPropertiesProto` because it is "magical"
    // in that it provides access to elements by id.
    //
    // Once we get the iframe info ready, and all mapped, we can proceed to
    // detach the iframe only if `options.keepAlive` isn't true.
    if (keepAlive) {
        // TODO: Temporary hack to preserve the document reference in Firefox.
        // https://bugzilla.mozilla.org/show_bug.cgi?id=543435
        const { document: redDocument } = redWindow;
        ReflectApply(DocumentProtoOpen, redDocument, []);
        ReflectApply(DocumentProtoClose, redDocument, []);
    } else {
        ReflectApply(ElementProtoRemove, iframe, []);
    }
    return env;
}

export default createIframeVirtualEnvironment;
