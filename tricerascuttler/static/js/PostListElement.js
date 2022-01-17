import * as _PostElement from "./PostElement.js";
import { runQuery } from "./web-util.js";

export class PostListElement extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this.query = this.getAttribute("query");
    this.loadSize = parseInt(this.getAttribute("loadSize") ?? 20);

    this.currentOffset = 0;

    this.shadowRoot.innerHTML = `
    <style>
    .post {
      display: block;
      margin: 5px;
    }

  
    </style>

    <div id="content">

    </div>

    `;
  }

  connectedCallback() {
    const contentDiv = this.shadowRoot.getElementById("content");
    this.getPostsAndAppend(contentDiv);
  }

  async getPosts(offset, limit) {
    console.log(`Getting post from ${offset} with limit ${limit}`);
    const resultJson = await runQuery(
      this.query + `OFFSET ${offset} LIMIT ${limit}`,
    );
    return resultJson.results.bindings.map((binding) => binding.post.value);
  }

  async getPostsAndAppend(targetElement) {
    const observerOptions = {
      root: null,
      rootMargin: "0px",
      threshold: 0,
    };

    let expanding = false;
    const observer = new IntersectionObserver((entries) => {
      entries.filter((entry) => entry.isIntersecting).some((_entry) => {
        if (!expanding) {
          expanding = true;
          this.getPostsAndAppend(targetElement);
        }
        return true;
      });
    }, observerOptions);

    observer.disconnect();

    await this.getPosts(this.currentOffset, this.loadSize + 1).then(
      (posts) => {
        if (posts.length > 0) {
          this.currentOffset += this.loadSize;
          targetElement.insertAdjacentHTML(
            "beforeend",
            `<div class="posts">
          ${
              [...posts].slice(0, this.loadSize).map((p) =>
                `<ssb-post src="${p}" class="post"></ssb-post>`
              ).join("")
            }
          </div>`,
          );
          if (posts.length > this.loadSize) {
            const postsElts = this.shadowRoot.querySelectorAll(".post");
            const lastPost = postsElts[postsElts.length - 1];
            observer.observe(lastPost);
          }
        } else {
          if (this.currentOffset === 0) {
            targetElement.insertAdjacentHTML(
              "beforeend",
              `No posts found with given query: <code><pre>${
                this.query.replaceAll("<", "&lt;")
              }</pre></code>`,
            );
          } else {
            //This shouldn't happen as we don't search if there isn't one more post
            targetElement.insertAdjacentHTML(
              "beforeend",
              `No more posts.`,
            );
          }
        }
      },
    );
  }
}
window.customElements.define("ssb-post-list", PostListElement);
